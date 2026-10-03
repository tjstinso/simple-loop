import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { FOLLOWUPS_DDL } from '../../../src/engines/software/followups.js';
import { migrate, openDb } from '../../../src/kernel/db.js';
import { createSoftwareEngine } from '../../../src/engines/software/index.js';
import { ExecutionResultSchema, ReviewVerdictSchema, LABEL_IN_PROGRESS } from '../../../src/engines/software/schemas.js';
import { SoftwareStateSchema, type SoftwareState } from '../../../src/engines/software/state.js';
import type { GitPorts } from '../../../src/engines/software/git-ports.js';
import type { GitWorkspaceProvider, SoftwareWorkspace } from '../../../src/engines/software/workspace.js';
import { EffectError, type ChainView, type DeadLetter, type EffectFence, type Job } from '../../../src/kernel/types.js';
import { PolicyStore } from '../../../src/policy/store.js';
import { FakeGitHost } from '../../support/fake-github.js';

const REPO = 'acme/widgets';
const DAY = 86_400_000;

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
  const teardowns: Array<{ jobId: number; delivery: number; outcome: string }> = [];
  const sweeps: Array<Set<string>> = [];
  let sweepError: Error | null = null;
  const stub = workspaces as unknown as {
    teardown: (c: unknown, j: Job, outcome: string) => Promise<void>;
    sweep: (live: Set<string>) => Promise<string[]>;
  };
  stub.teardown = async (_c, j, outcome) => {
    teardowns.push({ jobId: j.id, delivery: j.delivery, outcome });
  };
  stub.sweep = async (live) => {
    sweeps.push(live);
    if (sweepError) throw sweepError;
    return [];
  };
  const db = openDb(':memory:');
  migrate(db, [FOLLOWUPS_DDL]);
  const engine = createSoftwareEngine({
    db,
    now: () => 1_000,
    host,
    git,
    workspaces,
    policies: new PolicyStore([]),
    config: { defaultProfile: 'supervised', requiredSections: [], historyRetentionDays: 30, keptWorktreeMaxAgeMs: 7 * DAY },
    sleep: async () => {},
  });
  return {
    host, git, engine, prepared, db, teardowns, sweeps,
    failSweep: (e: Error) => { sweepError = e; },
  };
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

  it('buildRunInput fetches the issue and builds an execute subject', async () => {
    const { engine } = make();
    const out = await engine.buildRunInput(chain(), job(), ws);
    expect(out.subject).toEqual({
      kind: 'execute', repo: REPO, issueNumber: 7, title: 't', body: 'b', labels: [LABEL_IN_PROGRESS], attempt: 2,
    });
  });

  it('buildRunInput for a review job also looks up the PR', async () => {
    const { engine, host } = make();
    const pr = await host.openPr(REPO, { head: 'factory/issue-7', base: 'main', title: 't', body: 'b' });
    const out = await engine.buildRunInput(chain(), { ...job(), type: 'review' }, ws);
    expect(out.subject).toMatchObject({ kind: 'review', prNumber: pr.number, baseBranch: 'main' });
  });

  it('buildRunInput rejects when a review job has no PR', async () => {
    const { engine } = make();
    await expect(engine.buildRunInput(chain(), { ...job(), type: 'review' }, ws)).rejects.toThrow(
      'no PR found for review of factory/issue-7',
    );
  });

  describe('cleanup and sweep', () => {
    function seedChain(db: Database.Database): void {
      db.prepare(
        "INSERT INTO chains (id, engine, subject_key, status, engine_state, created_at, updated_at) VALUES (3, 'software', 'k', 'active', '{}', 0, 0)",
      ).run();
    }
    function seedJob(db: Database.Database, id: number, status: string, delivery: number): void {
      db.prepare(
        `INSERT INTO jobs (id, chain_id, type, attempt, status, policy_id, delivery, created_at, updated_at)
         VALUES (?, 3, 'execute', ?, ?, 'p', ?, 0, 0)`,
      ).run(id, id, status, delivery);
    }
    function seedDeadLetter(db: Database.Database, jobId: number, createdAt: number, resolvedAt: number | null): void {
      db.prepare(
        `INSERT INTO dead_letters (job_id, chain_id, reason, error, created_at, resolved_at)
         VALUES (?, 3, 'runner_error', 'e', ?, ?)`,
      ).run(jobId, createdAt, resolvedAt);
    }
    function seedFollowup(db: Database.Database, pos: number, title: string, filed: number | null, createdAt: number): void {
      db.prepare(
        `INSERT INTO followups (job_id, chain_id, repo, issue_number, position, title, body, filed_issue_number, created_at)
         VALUES (1, 3, ?, 7, ?, ?, 'b', ?, ?)`,
      ).run(REPO, pos, title, filed, createdAt);
    }

    it('cleanup removes the workspace and forgets the cache for a succeeded job', async () => {
      const { engine, db, teardowns, git } = make();
      seedChain(db);
      seedJob(db, 42, 'succeeded', 1);
      await engine.workspace.prepare(chain(), job(1));
      await engine.cleanup(chain(), job(1));
      expect(teardowns).toEqual([{ jobId: 42, delivery: 1, outcome: 'ok' }]);
      await expect(
        engine.runEffect({ kind: 'commit_push' }, { chain: chain(), job: job(1), fence: fence() }),
      ).rejects.toBeInstanceOf(EffectError);
      expect(git.calls).toEqual([]);
    });

    it('cleanup keeps the workspace for a failed job when keepOnFailure is true', async () => {
      const { engine, db, teardowns } = make();
      seedChain(db);
      seedJob(db, 42, 'failed', 1);
      await engine.cleanup(chain(), job(1));
      // the provider decides to keep on failure; the engine reports the outcome
      expect(teardowns).toEqual([{ jobId: 42, delivery: 1, outcome: 'failed' }]);
    });

    it('cleanup removes the workspace for an aborted job still running', async () => {
      const { engine, db, teardowns } = make();
      seedChain(db);
      seedJob(db, 42, 'running', 2);
      await engine.cleanup(chain(), job(1));
      expect(teardowns).toEqual([{ jobId: 42, delivery: 1, outcome: 'ok' }]);
    });

    it('sweep retries unfiled followups, prunes filed ones and sweeps workspaces with the live key set', async () => {
      const { engine, db, host, sweeps } = make();
      const NOW = 100 * DAY;
      seedChain(db);
      seedJob(db, 1, 'running', 4);
      seedJob(db, 2, 'failed', 1); // recent unresolved dead letter: live
      seedDeadLetter(db, 2, NOW - DAY, null);
      seedJob(db, 3, 'failed', 5); // old dead letter: not live
      seedDeadLetter(db, 3, NOW - 8 * DAY, null);
      seedJob(db, 4, 'failed', 2); // resolved dead letter: not live
      seedDeadLetter(db, 4, NOW - DAY, NOW - 1);
      seedJob(db, 5, 'succeeded', 6);
      seedJob(db, 6, 'failed', 3); // failed without a dead letter: not live
      seedFollowup(db, 0, 'unfiled', null, NOW - 1);
      seedFollowup(db, 1, 'old filed', 9, NOW - 40 * DAY);
      seedFollowup(db, 2, 'recent filed', 10, NOW - DAY);
      await engine.sweep!(NOW);
      const left = db.prepare('SELECT title, filed_issue_number FROM followups ORDER BY position').all() as Array<{
        title: string;
        filed_issue_number: number | null;
      }>;
      expect(left.map((r) => r.title)).toEqual(['unfiled', 'recent filed']);
      expect(left[0]!.filed_issue_number).not.toBeNull();
      expect(host.issues.size).toBe(2);
      expect(sweeps).toHaveLength(1);
      expect([...sweeps[0]!].sort()).toEqual(['3:1', '3:4']);
    });

    it('sweep runs every step and rethrows the first error afterwards', async () => {
      const { engine, db, host, sweeps, failSweep } = make();
      seedChain(db);
      seedJob(db, 1, 'running', 1);
      seedFollowup(db, 0, 'unfiled', null, 0);
      seedFollowup(db, 1, 'old filed', 5, 0);
      host.failNext('findIssueByMarker', new TypeError('filing bug'));
      failSweep(new Error('workspace sweep failed'));
      await expect(engine.sweep!(100 * DAY)).rejects.toThrow('filing bug');
      expect(sweeps).toHaveLength(1); // the workspace step still ran
      const titles = (db.prepare('SELECT title FROM followups').all() as Array<{ title: string }>).map((r) => r.title);
      expect(titles).toEqual(['unfiled']); // the prune step still ran
    });
  });
});
