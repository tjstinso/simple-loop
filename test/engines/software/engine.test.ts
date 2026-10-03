import { describe, expect, it } from 'vitest';
import { createSoftwareEngine } from '../../../src/engines/software/index.js';
import { ExecutionResultSchema, ReviewVerdictSchema, LABEL_IN_PROGRESS } from '../../../src/engines/software/schemas.js';
import { SoftwareStateSchema, type SoftwareState } from '../../../src/engines/software/state.js';
import type { GitPorts } from '../../../src/engines/software/git-ports.js';
import type { GitWorkspaceProvider, SoftwareWorkspace } from '../../../src/engines/software/workspace.js';
import { EffectError, type ChainView, type DeadLetter, type EffectFence, type Job } from '../../../src/kernel/types.js';
import { PolicyStore } from '../../../src/policy/store.js';
import { FakeGitHost } from '../../support/fake-github.js';

const REPO = 'acme/widgets';

const state = (over: Partial<SoftwareState> = {}): SoftwareState => ({
  repo: REPO,
  issueNumber: 7,
  labels: [],
  profile: 'supervised',
  branch: 'factory/issue-7',
  attempt: 2,
  phase: 'reviewing',
  ...over,
});
const chain = (id = 3, over: Partial<SoftwareState> = {}): ChainView<SoftwareState> => ({
  id,
  engine: 'software',
  subjectKey: `${REPO}#7`,
  status: 'active',
  state: state(over),
});
const job = (delivery = 1): Job => ({
  id: 42, chainId: 3, type: 'execute', attempt: 1, status: 'running', policyId: 'p', payload: {}, result: null,
  claimedBy: 'w', leaseExpiresAt: null, delivery, error: null,
});
const fence = (): EffectFence => ({ jobId: 42, delivery: 1, assertCurrent: () => {} });
const dl = (): DeadLetter => ({
  jobId: 42, chainId: 3, reason: 'max_deliveries', error: 'it exploded', stepLogPath: null, createdAt: 1, resolvedAt: null,
});

class RecordingGit implements GitPorts {
  readonly calls: string[] = [];
  async commitAll(): Promise<boolean> { this.calls.push('commitAll'); return true; }
  async headSha(): Promise<string> { this.calls.push('headSha'); return 'x'; }
  async push(): Promise<void> { this.calls.push('push'); }
}

const ws: SoftwareWorkspace = {
  path: '/ws', localBranch: 'l', remoteBranch: 'factory/issue-7', remoteUrl: '/r.git',
  remoteHeadSha: null, seedSha: 'seed', baseBranch: 'main',
};

function make() {
  const host = new FakeGitHost();
  host.addIssue({ number: 7, title: 't', body: 'b', labels: [LABEL_IN_PROGRESS] });
  const git = new RecordingGit();
  const prepared: number[] = [];
  const workspaces = {
    prepare: async (_c: unknown, j: Job) => {
      prepared.push(j.delivery);
      return ws;
    },
  } as unknown as GitWorkspaceProvider;
  const engine = createSoftwareEngine({
    host,
    git,
    workspaces,
    policies: new PolicyStore([]),
    config: { defaultProfile: 'supervised', requiredSections: [] },
    sleep: async () => {},
  });
  return { host, git, engine, prepared };
}

describe('software engine', () => {
  it('surfaceDeadLetter labels the issue and comments once even if called twice', async () => {
    const { host, engine } = make();
    await engine.surfaceDeadLetter(chain(), dl());
    await engine.surfaceDeadLetter(chain(), dl());
    expect(host.getLabels(7)).toContain('factory:dead-letter');
    expect(host.getLabels(7)).not.toContain(LABEL_IN_PROGRESS);
    const comments = host.getComments(7);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain('max_deliveries');
    expect(comments[0]).toContain('it exploded');
    expect(comments[0]).toContain('42');
    expect(comments[0]).toContain('<!-- factory:chain=3 job=42 event=dead-letter -->');
  });

  it('describe renders repo, phase, attempt and profile', () => {
    expect(make().engine.describe(chain())).toBe('acme/widgets#7 phase=reviewing attempt=2 profile=supervised');
  });

  it('runEffect passes the cached workspace of this delivery to the effect', async () => {
    const { engine, git, prepared } = make();
    await engine.workspace.prepare(chain(), job(1));
    expect(prepared).toEqual([1]);
    await engine.runEffect({ kind: 'commit_push' }, { chain: chain(), job: job(1), fence: fence() });
    expect(git.calls).toContain('commitAll');
    // a different delivery has no cached workspace
    git.calls.length = 0;
    await expect(
      engine.runEffect({ kind: 'commit_push' }, { chain: chain(), job: job(2), fence: fence() }),
    ).rejects.toBeInstanceOf(EffectError);
    expect(git.calls).toEqual([]);
    // forgetting evicts
    engine.forgetWorkspace(3, 1);
    await expect(
      engine.runEffect({ kind: 'commit_push' }, { chain: chain(), job: job(1), fence: fence() }),
    ).rejects.toBeInstanceOf(EffectError);
  });

  it('runEffect without a prior prepare gives commit_push the missing-workspace EffectError', async () => {
    const { engine } = make();
    const err = await engine
      .runEffect({ kind: 'commit_push' }, { chain: chain(), job: job(1), fence: fence() })
      .catch((e) => e);
    expect(err).toBeInstanceOf(EffectError);
    expect(err.message).toMatch(/workspace/i);
  });

  it('exposes the declared policyKinds, resultSchemas and id', () => {
    const { engine } = make();
    expect(engine.id).toBe('software');
    expect(engine.policyKinds).toEqual(['execute', 'review']);
    expect(engine.resultSchemas).toEqual({ execute: ExecutionResultSchema, review: ReviewVerdictSchema });
    expect(engine.stateSchema).toBe(SoftwareStateSchema);
  });

  it('the placeholders for buildRunInput and cleanup behave as documented', async () => {
    const { engine } = make();
    await expect(engine.buildRunInput(chain(), job(), ws)).rejects.toThrow('buildRunInput is implemented in Task 20');
    await expect(engine.cleanup(chain(), job())).resolves.toBeUndefined();
    expect(engine.sweep).toBeUndefined();
  });
});
