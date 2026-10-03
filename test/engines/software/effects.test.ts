import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EffectError, StaleDeliveryError, type ChainView, type Effect, type EffectFence, type Job } from '../../../src/kernel/types.js';
import type { SoftwareState } from '../../../src/engines/software/state.js';
import { GitWorkspaceProvider, type SoftwareWorkspace } from '../../../src/engines/software/workspace.js';
import { ExecGitPorts, type GitPorts } from '../../../src/engines/software/git-ports.js';
import { GitHostError } from '../../../src/engines/software/github.js';
import { runSoftwareEffect, type EffectContext } from '../../../src/engines/software/effects.js';
import { LABEL_IN_PROGRESS, LABEL_READY_FOR_MERGE } from '../../../src/engines/software/schemas.js';
import { FakeGitHost } from '../../support/fake-github.js';
import { GIT_TEST_ENV, makeRemote, type TempRemote } from '../../support/temp-repo.js';

const git = (cwd: string, args: string[]) =>
  execFileSync('git', args, { cwd, env: GIT_TEST_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const REPO = 'acme/widgets';
const ISSUE = 7;
const BRANCH = 'factory/issue-7';

function chain(over: Partial<SoftwareState> = {}): ChainView<SoftwareState> {
  return {
    id: 3, engine: 'software', subjectKey: 'k', status: 'active',
    state: { repo: REPO, issueNumber: ISSUE, labels: [], profile: 'supervised', branch: BRANCH, attempt: 1, phase: 'executing', ...over },
  };
}
function job(over: Partial<Job> = {}): Job {
  return {
    id: 42, chainId: 3, type: 'execute', attempt: 1, status: 'running', policyId: 'p', payload: {}, result: null,
    claimedBy: 'w', leaseExpiresAt: null, delivery: 1, error: null, ...over,
  };
}

function fence(): EffectFence & { checks: number } {
  const f = { jobId: 42, delivery: 1, checks: 0, assertCurrent: () => { f.checks++; } };
  return f;
}
function staleFence(): EffectFence {
  return { jobId: 42, delivery: 1, assertCurrent: () => { throw new StaleDeliveryError(); } };
}

class RecordingGit implements GitPorts {
  readonly calls: string[] = [];
  async commitAll(): Promise<boolean> { this.calls.push('commitAll'); return false; }
  async headSha(): Promise<string> { this.calls.push('headSha'); return 'x'; }
  async push(): Promise<void> { this.calls.push('push'); }
}

const fakeWs: SoftwareWorkspace = {
  repo: 'acme/widgets', path: '/nonexistent', localBranch: 'l', remoteBranch: BRANCH, remoteUrl: '/nonexistent.git',
  remoteHeadSha: null, seedSha: 'seed', baseBranch: 'main',
};

describe('runSoftwareEffect', () => {
  let host: FakeGitHost;
  let delays: number[];
  let rgit: RecordingGit;
  const ctx = (over: Partial<EffectContext> = {}): EffectContext => ({
    chain: chain(), job: job(), workspace: fakeWs, host, git: rgit,
    sleep: async (ms) => { delays.push(ms); }, ...over,
  });

  beforeEach(() => {
    host = new FakeGitHost();
    host.addIssue({ number: ISSUE, title: 'Add widgets', body: 'please', labels: [LABEL_IN_PROGRESS] });
    delays = [];
    rgit = new RecordingGit();
  });

  describe('git effects (real git)', () => {
    let remote: TempRemote;
    let root: string;
    let provider: GitWorkspaceProvider;
    const ports = new ExecGitPorts();
    const remoteHead = () => git(remote.path, ['rev-parse', `refs/heads/${BRANCH}`]);

    beforeEach(() => {
      remote = makeRemote();
      root = mkdtempSync(join(tmpdir(), 'factory-eff-'));
      provider = new GitWorkspaceProvider({ cloneUrlFor: () => remote.url, root, keepOnFailure: false });
    });
    afterEach(() => {
      remote.cleanup();
      rmSync(root, { recursive: true, force: true });
    });

    it('commit_push commits leftover changes and pushes with force-with-lease against the seed sha', async () => {
      const previous = remote.commit(BRANCH, 'first.txt', '1\n');
      const ws = await provider.prepare(chain({ attempt: 2 }), job({ delivery: 2, attempt: 2 }));
      expect(ws.remoteHeadSha).toBe(previous);
      writeFileSync(join(ws.path, 'leftover.txt'), 'left\n');
      const f = fence();
      await runSoftwareEffect({ kind: 'commit_push' }, ctx({ chain: chain({ attempt: 2 }), job: job({ attempt: 2 }), workspace: ws, git: ports }), f);
      const head = remoteHead();
      expect(head).not.toBe(previous);
      expect(git(remote.path, ['rev-parse', `${head}^`])).toBe(previous);
      expect(git(remote.path, ['log', '-1', '--format=%s', head])).toBe('factory: Add widgets (attempt 2)');
      expect(git(remote.path, ['show', `${head}:leftover.txt`])).toBe('left');
      expect(f.checks).toBeGreaterThanOrEqual(2);
    });

    it('commit_push with no changes at all throws no changes produced and opens no PR', async () => {
      const ws = await provider.prepare(chain(), job());
      const err = await runSoftwareEffect({ kind: 'commit_push' }, ctx({ workspace: ws, git: ports }), fence()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(EffectError);
      expect((err as EffectError).reason).toBe('runner_error');
      expect((err as EffectError).message).toMatch(/no changes produced/);
      expect(host.prs.size).toBe(0);
      expect(git(remote.path, ['branch', '--list', BRANCH])).toBe('');
    });

    it('commit_push uses the agent own commit when the tree is clean', async () => {
      const ws = await provider.prepare(chain(), job());
      writeFileSync(join(ws.path, 'agent.txt'), 'a\n');
      git(ws.path, ['add', '.']);
      git(ws.path, ['commit', '-m', 'agent commit']);
      const agentSha = git(ws.path, ['rev-parse', 'HEAD']);
      await runSoftwareEffect({ kind: 'commit_push' }, ctx({ workspace: ws, git: ports }), fence());
      expect(remoteHead()).toBe(agentSha);
    });

    it('commit_push pushing the same commit twice is a no-op', async () => {
      const ws = await provider.prepare(chain(), job());
      writeFileSync(join(ws.path, 'a.txt'), 'a\n');
      await runSoftwareEffect({ kind: 'commit_push' }, ctx({ workspace: ws, git: ports }), fence());
      const head = remoteHead();
      await runSoftwareEffect({ kind: 'commit_push' }, ctx({ workspace: ws, git: ports }), fence());
      expect(remoteHead()).toBe(head);
      expect(git(ws.path, ['rev-parse', 'HEAD'])).toBe(head);
    });

    class SpyGit implements GitPorts {
      pushes = 0;
      commitAll(ws: SoftwareWorkspace, m: string) { return ports.commitAll(ws, m); }
      headSha(ws: SoftwareWorkspace) { return ports.headSha(ws); }
      push(ws: SoftwareWorkspace, a: { remoteBranch: string; expectSha: string | null }) { this.pushes++; return ports.push(ws, a); }
    }

    it('commit_push on an already-published branch with no new changes succeeds without pushing', async () => {
      const published = remote.commit(BRANCH, 'done.txt', 'd\n');
      const ws = await provider.prepare(chain(), job({ delivery: 2 }));
      expect(ws.remoteHeadSha).toBe(published);
      const spy = new SpyGit();
      await runSoftwareEffect({ kind: 'commit_push' }, ctx({ workspace: ws, git: spy }), fence());
      expect(spy.pushes).toBe(0);
      expect(remoteHead()).toBe(published);
    });

    it('commit_push with no changes and no published branch still throws no changes produced', async () => {
      const ws = await provider.prepare(chain(), job());
      const spy = new SpyGit();
      const err = await runSoftwareEffect({ kind: 'commit_push' }, ctx({ workspace: ws, git: spy }), fence()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(EffectError);
      expect((err as EffectError).reason).toBe('runner_error');
      expect((err as Error).message).toBe('no changes produced');
      expect(spy.pushes).toBe(0);
    });

    it('after a post-push crash the rerun lets open_pr open the missing PR', async () => {
      const published = remote.commit(BRANCH, 'done.txt', 'd\n');
      const ws = await provider.prepare(chain(), job({ delivery: 3 }));
      await runSoftwareEffect({ kind: 'commit_push' }, ctx({ workspace: ws, git: ports }), fence());
      await runSoftwareEffect({ kind: 'open_pr' }, ctx({ workspace: ws, git: ports }), fence());
      expect(remoteHead()).toBe(published);
      const open = [...host.prs.values()].filter((p) => p.head === BRANCH && p.state === 'open');
      expect(open).toHaveLength(1);
    });

    it('commit_push replay with a non-null expected sha and the remote already at HEAD is a no-op', async () => {
      const previous = remote.commit(BRANCH, 'first.txt', '1\n');
      const ws = await provider.prepare(chain(), job({ delivery: 2 }));
      expect(ws.remoteHeadSha).toBe(previous);
      writeFileSync(join(ws.path, 'more.txt'), 'm\n');
      await runSoftwareEffect({ kind: 'commit_push' }, ctx({ workspace: ws, git: ports }), fence());
      const head = remoteHead();
      expect(head).not.toBe(previous);
      await runSoftwareEffect({ kind: 'commit_push' }, ctx({ workspace: ws, git: ports }), fence());
      expect(remoteHead()).toBe(head);
      expect(git(ws.path, ['rev-parse', 'HEAD'])).toBe(head);
    });

    it('commit_push throws StaleDeliveryError when the remote branch moved', async () => {
      remote.commit(BRANCH, 'first.txt', '1\n');
      const ws = await provider.prepare(chain(), job({ delivery: 2 }));
      const moved = remote.commit(BRANCH, 'zombie.txt', 'z\n');
      writeFileSync(join(ws.path, 'mine.txt'), 'm\n');
      await expect(runSoftwareEffect({ kind: 'commit_push' }, ctx({ workspace: ws, git: ports }), fence())).rejects.toBeInstanceOf(
        StaleDeliveryError,
      );
      expect(remoteHead()).toBe(moved);
    });

    it('a stale fence stops commit_push before it pushes', async () => {
      const ws = await provider.prepare(chain(), job());
      writeFileSync(join(ws.path, 'a.txt'), 'a\n');
      await expect(runSoftwareEffect({ kind: 'commit_push' }, ctx({ workspace: ws, git: ports }), staleFence())).rejects.toBeInstanceOf(
        StaleDeliveryError,
      );
      expect(git(remote.path, ['branch', '--list', BRANCH])).toBe('');
      expect(host.calls).toEqual([]);
    });
  });

  it('commit_push sanitizes the shared repository config before it commits and pushes', async () => {
    const order: string[] = [];
    const g: GitPorts = {
      prepareForPush: async () => void order.push('prepareForPush'),
      commitAll: async () => (order.push('commitAll'), true),
      headSha: async () => (order.push('headSha'), 'new'),
      push: async () => void order.push('push'),
    };
    await runSoftwareEffect({ kind: 'commit_push' }, ctx({ git: g }), fence());
    expect(order).toEqual(['prepareForPush', 'commitAll', 'headSha', 'push']);
  });

  it("an execute job's commit_push git or host failure is a runner_error (a retry reruns the agent)", async () => {
    const pushFails: GitPorts = {
      commitAll: async () => true,
      headSha: async () => 'new',
      push: async () => {
        throw new Error('git push failed: Could not resolve host: github.com');
      },
    };
    const cases: Array<[string, () => unknown]> = [
      ['git push failed: Could not resolve host: github.com', () => ctx({ git: pushFails })],
      ['Not Found', () => { host.failNext('getIssue', new GitHostError('Not Found', 404)); return ctx(); }],
    ];
    for (const [message, mk] of cases) {
      const err = await runSoftwareEffect({ kind: 'commit_push' }, mk() as EffectContext, fence()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(EffectError);
      expect((err as EffectError).reason).toBe('runner_error');
      expect((err as Error).message).toBe(message);
    }
    // A transient host failure is still retried first.
    delays = [];
    host.getIssue = async () => {
      throw new GitHostError('bad gateway', 502);
    };
    const err = await runSoftwareEffect({ kind: 'commit_push' }, ctx(), fence()).catch((e: unknown) => e);
    expect((err as EffectError).reason).toBe('runner_error');
    expect(delays).toEqual([100, 200]);
  });

  it("an execute job's open_pr host failure is a runner_error", async () => {
    host.failNext('openPr', new GitHostError('Validation Failed', 422));
    const err = await runSoftwareEffect({ kind: 'open_pr' }, ctx(), fence()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EffectError);
    expect((err as EffectError).reason).toBe('runner_error');
    expect((err as Error).message).toBe('Validation Failed');
  });

  it("a review job's effect failures stay effect_error (its retry keeps the verdict)", async () => {
    const review = job({ type: 'review' });
    const err = await runSoftwareEffect({ kind: 'set_labels', target: 'pr', add: ['x'], remove: [] }, ctx({ job: review }), fence()).catch(
      (e: unknown) => e,
    );
    expect((err as EffectError).reason).toBe('effect_error');
    host.failNext('setLabels', new GitHostError('Validation Failed', 422));
    const err2 = await runSoftwareEffect({ kind: 'set_labels', target: 'issue', add: ['x'], remove: [] }, ctx({ job: review }), fence()).catch(
      (e: unknown) => e,
    );
    expect((err2 as EffectError).reason).toBe('effect_error');
  });

  it('commit_push with a missing workspace throws EffectError runner_error', async () => {
    const err = await runSoftwareEffect({ kind: 'commit_push' }, ctx({ workspace: null }), fence()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EffectError);
    expect((err as EffectError).reason).toBe('runner_error');
    expect((err as Error).message).toBe('workspace for this delivery is gone; retry will rerun the agent');
    expect(rgit.calls).toEqual([]);
  });

  it('open_pr with a missing workspace throws EffectError runner_error', async () => {
    const err = await runSoftwareEffect({ kind: 'open_pr' }, ctx({ workspace: null }), fence()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EffectError);
    expect((err as EffectError).reason).toBe('runner_error');
    expect(host.prs.size).toBe(0);
  });

  it('open_pr on a closed issue is an effect_error and opens no PR', async () => {
    host.issues.get(ISSUE)!.state = 'closed';
    const err = await runSoftwareEffect({ kind: 'open_pr' }, ctx(), fence()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EffectError);
    expect((err as EffectError).reason).toBe('effect_error');
    expect((err as Error).message).toBe(`issue #${ISSUE} is closed`);
    expect(host.prs.size).toBe(0);
  });

  it('merge_pr on a closed issue is an effect_error and merges nothing', async () => {
    const pr = await host.openPr(REPO, { head: BRANCH, base: 'main', title: 't', body: 'b' });
    host.issues.get(ISSUE)!.state = 'closed';
    const err = await runSoftwareEffect({ kind: 'merge_pr' }, ctx({ job: job({ type: 'review' }) }), fence()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EffectError);
    expect((err as EffectError).reason).toBe('effect_error');
    expect((err as Error).message).toBe(`issue #${ISSUE} is closed`);
    expect(host.prs.get(pr.number)?.state).toBe('open');
    expect(host.calls.map((c) => c.method)).not.toContain('mergePr');
  });

  it('the closed-issue check re-reads the issue through the transient retry', async () => {
    const pr = await host.openPr(REPO, { head: BRANCH, base: 'main', title: 't', body: 'b' });
    host.failNext('getIssue', new GitHostError('bad gateway', 502));
    await runSoftwareEffect({ kind: 'merge_pr' }, ctx({ job: job({ type: 'review' }) }), fence());
    expect(host.prs.get(pr.number)?.state).toBe('merged');
    expect(delays).toEqual([100]);
  });

  it('open_pr reuses an existing open PR for the branch', async () => {
    const pr = await host.openPr(REPO, { head: BRANCH, base: 'main', title: 't', body: 'b' });
    host.calls.length = 0;
    await runSoftwareEffect({ kind: 'open_pr' }, ctx(), fence());
    expect(host.prs.size).toBe(1);
    expect(host.prs.get(pr.number)?.state).toBe('open');
    expect(host.calls.map((c) => c.method)).not.toContain('openPr');
  });

  it('open_pr opens a new PR when the earlier one for the branch is closed', async () => {
    const old = await host.openPr(REPO, { head: BRANCH, base: 'main', title: 't', body: 'b' });
    host.prs.get(old.number)!.state = 'closed';
    await runSoftwareEffect({ kind: 'open_pr' }, ctx(), fence());
    expect(host.prs.size).toBe(2);
  });

  it('open_pr opens a PR with Closes #n and the marker body', async () => {
    const f = fence();
    await runSoftwareEffect(
      { kind: 'open_pr' },
      ctx({ job: job({ result: { status: 'ok', summary: 'Added the widget factory.' } }) }),
      f,
    );
    expect(host.prs.size).toBe(1);
    const pr = [...host.prs.values()][0]!;
    expect(pr.head).toBe(BRANCH);
    expect(pr.baseBranch).toBe('main');
    expect(pr.title).toBe('Add widgets');
    expect(pr.body).toBe('Closes #7\n\nAdded the widget factory.\n\n<!-- factory:chain=3 job=42 event=open-pr -->');
    expect(f.checks).toBeGreaterThanOrEqual(2);
  });

  it('open_pr body omits the summary when the job has no result', async () => {
    await runSoftwareEffect({ kind: 'open_pr' }, ctx(), fence());
    const pr = [...host.prs.values()][0]!;
    expect(pr.body).toBe('Closes #7\n\n<!-- factory:chain=3 job=42 event=open-pr -->');
  });

  it('set_labels sets specific labels and is repeatable', async () => {
    const pr = await host.openPr(REPO, { head: BRANCH, base: 'main', title: 't', body: 'b' });
    const onIssue: Effect = { kind: 'set_labels', target: 'issue', add: [LABEL_READY_FOR_MERGE], remove: [LABEL_IN_PROGRESS] };
    const onPr: Effect = { kind: 'set_labels', target: 'pr', add: [LABEL_READY_FOR_MERGE], remove: [] };
    for (let i = 0; i < 2; i++) {
      await runSoftwareEffect(onIssue, ctx(), fence());
      await runSoftwareEffect(onPr, ctx({ workspace: null }), fence());
    }
    expect(host.getLabels(ISSUE)).toEqual([LABEL_READY_FOR_MERGE]);
    expect(host.getLabels(pr.number)).toEqual([LABEL_READY_FOR_MERGE]);
  });

  it('set_labels on the pr target with no PR is an effect_error', async () => {
    const err = await runSoftwareEffect({ kind: 'set_labels', target: 'pr', add: ['x'], remove: [] }, ctx(), fence()).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(EffectError);
    expect((err as EffectError).reason).toBe('effect_error');
    expect((err as Error).message).toBe('no PR found for label target');
  });

  it('merge_pr checks PR state first and is a no-op when already merged', async () => {
    const pr = await host.openPr(REPO, { head: BRANCH, base: 'main', title: 't', body: 'b' });
    await runSoftwareEffect({ kind: 'merge_pr' }, ctx({ workspace: null }), fence());
    expect(host.prs.get(pr.number)?.state).toBe('merged');
    host.calls.length = 0;
    await runSoftwareEffect({ kind: 'merge_pr' }, ctx(), fence());
    expect(host.calls.map((c) => c.method)).toEqual(['findPrByHead']);
  });

  it('merge_pr on a closed unmerged PR is an effect_error', async () => {
    const pr = await host.openPr(REPO, { head: BRANCH, base: 'main', title: 't', body: 'b' });
    host.prs.get(pr.number)!.state = 'closed';
    const err = await runSoftwareEffect({ kind: 'merge_pr' }, ctx(), fence()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EffectError);
    expect((err as EffectError).reason).toBe('effect_error');
    expect((err as Error).message).toBe('PR is closed and cannot be merged');
  });

  it('merge refused (GitHostError 405 and 409) becomes effect_error and leaves the PR open', async () => {
    const pr = await host.openPr(REPO, { head: BRANCH, base: 'main', title: 't', body: 'b' });
    for (const status of [405, 409]) {
      host.failNext('mergePr', new GitHostError('Pull Request is not mergeable', status));
      const err = await runSoftwareEffect({ kind: 'merge_pr' }, ctx(), fence()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(EffectError);
      expect((err as EffectError).reason).toBe('effect_error');
      expect((err as Error).message).toBe('merge refused: Pull Request is not mergeable');
      expect(host.prs.get(pr.number)?.state).toBe('open');
    }
    expect(delays).toEqual([]);
  });

  it('a GitHostError 404 on the issue becomes effect_error', async () => {
    host.issues.delete(ISSUE);
    const err = await runSoftwareEffect(
      { kind: 'comment', target: 'issue', body: 'hi', marker: '<!-- m -->' },
      ctx(),
      fence(),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EffectError);
    expect((err as EffectError).reason).toBe('effect_error');
    expect((err as Error).message).toBe('Not Found');
  });

  it('transient GitHostError is retried with backoff three times, then effect_error', async () => {
    for (const make of [() => new GitHostError('bad gateway', 502), () => new GitHostError('rate limited', 429), () => new GitHostError('network down')]) {
      delays = [];
      let attempts = 0;
      host.setLabels = async () => {
        attempts++;
        throw make();
      };
      const err = await runSoftwareEffect(
        { kind: 'set_labels', target: 'issue', add: ['x'], remove: [] },
        ctx(),
        fence(),
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(EffectError);
      expect((err as EffectError).reason).toBe('effect_error');
      expect((err as Error).message).toBe(make().message);
      expect(attempts).toBe(3);
      expect(delays).toEqual([100, 200]);
    }
  });

  it('a transient failure that recovers succeeds', async () => {
    host.failNext('setLabels', new GitHostError('bad gateway', 503));
    await runSoftwareEffect({ kind: 'set_labels', target: 'issue', add: ['x'], remove: [] }, ctx(), fence());
    expect(host.getLabels(ISSUE)).toContain('x');
    expect(delays).toEqual([100]);
  });

  it('a 404 is not retried', async () => {
    let attempts = 0;
    host.setLabels = async () => {
      attempts++;
      throw new GitHostError('Not Found', 404);
    };
    const err = await runSoftwareEffect({ kind: 'set_labels', target: 'issue', add: ['x'], remove: [] }, ctx(), fence()).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(EffectError);
    expect((err as EffectError).reason).toBe('effect_error');
    expect(attempts).toBe(1);
    expect(delays).toEqual([]);
  });

  it('non-GitHostError exceptions from the host propagate unchanged', async () => {
    const boom = new TypeError('boom');
    host.failNext('setLabels', boom);
    await expect(runSoftwareEffect({ kind: 'set_labels', target: 'issue', add: ['x'], remove: [] }, ctx(), fence())).rejects.toBe(boom);
    expect(delays).toEqual([]);
  });

  it('a stale fence stops the effect before it acts', async () => {
    await host.openPr(REPO, { head: BRANCH, base: 'main', title: 't', body: 'b' });
    host.calls.length = 0;
    const effects: Effect[] = [
      { kind: 'commit_push' },
      { kind: 'open_pr' },
      { kind: 'set_labels', target: 'issue', add: ['x'], remove: [] },
      { kind: 'merge_pr' },
      { kind: 'comment', target: 'issue', body: 'hi', marker: '<!-- m -->' },
    ];
    for (const e of effects) {
      await expect(runSoftwareEffect(e, ctx(), staleFence())).rejects.toBeInstanceOf(StaleDeliveryError);
    }
    expect(host.calls).toEqual([]);
    expect(rgit.calls).toEqual([]);
  });

  it('a fence that goes stale between the look and the act stops the mutation', async () => {
    let n = 0;
    const f: EffectFence = { jobId: 42, delivery: 1, assertCurrent: () => { if (++n > 1) throw new StaleDeliveryError(); } };
    await expect(
      runSoftwareEffect({ kind: 'comment', target: 'issue', body: 'hi', marker: '<!-- m -->' }, ctx(), f),
    ).rejects.toBeInstanceOf(StaleDeliveryError);
    expect(host.getComments(ISSUE)).toEqual([]);
    expect(host.calls.map((c) => c.method)).toEqual(['findComment']);
  });

  it('comment skips when the marker already exists', async () => {
    await host.comment(REPO, ISSUE, 'earlier\n\n<!-- factory:chain=3 job=42 event=x -->');
    await runSoftwareEffect(
      { kind: 'comment', target: 'issue', body: 'hi', marker: '<!-- factory:chain=3 job=42 event=x -->' },
      ctx(),
      fence(),
    );
    expect(host.getComments(ISSUE)).toHaveLength(1);
  });

  it('comment posts body plus marker the first time', async () => {
    const pr = await host.openPr(REPO, { head: BRANCH, base: 'main', title: 't', body: 'b' });
    await runSoftwareEffect({ kind: 'comment', target: 'issue', body: 'hello', marker: '<!-- m1 -->' }, ctx(), fence());
    await runSoftwareEffect({ kind: 'comment', target: 'pr', body: 'on pr', marker: '<!-- m2 -->' }, ctx(), fence());
    expect(host.getComments(ISSUE)).toEqual(['hello\n\n<!-- m1 -->']);
    expect(host.getComments(pr.number)).toEqual(['on pr\n\n<!-- m2 -->']);
  });

  it('rejects an unknown effect kind as unsupported', async () => {
    await expect(runSoftwareEffect({ kind: 'bogus' }, ctx(), fence())).rejects.toThrow('unsupported effect: bogus');
    await expect(runSoftwareEffect({ kind: 'set_labels', target: 'nope' }, ctx(), fence())).rejects.toThrow(/invalid set_labels effect/);
    expect(host.calls).toEqual([]);
  });
});
