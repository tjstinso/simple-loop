import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SoftwareWorkspace } from '../../src/engines/software/workspace.js';
import type { DeliveryOutcome } from '../../src/kernel/process-delivery.js';
import { LEASE_MS, deferred, makeHarness, ok, type Harness } from '../support/harness.js';

const N = 7;
const BRANCH = `factory/issue-${N}`;
const READY = 'factory:ready-for-merge';

let h: Harness | undefined;
/** Releases anything a test left blocked, so no promise outlives the test. */
let releaseAll: Array<() => void> = [];
/** In-flight deliveries a test started and must settle before cleanup. */
let pending: Array<Promise<unknown>> = [];

afterEach(async () => {
  for (const r of releaseAll.splice(0)) r();
  await Promise.allSettled(pending.splice(0));
  h?.cleanup();
  h = undefined;
});

/** Settled snapshot of everything a delivery could publish. */
function published(x: Harness) {
  return {
    prs: [...x.host.prs.values()].map((p) => ({ ...p })),
    issueLabels: x.issueLabels(N),
    prLabels: x.pr(BRANCH)?.labels ?? null,
    comments: x.comments(N),
    issues: [...x.host.issues.keys()],
    branches: x.remoteBranches(),
    head: x.remoteHead(BRANCH),
  };
}

describe('zombie deliveries', () => {
  it('a zombie delivery works in its own workspace and cannot publish', async () => {
    h = makeHarness();
    const x = h;
    const { chain, job } = await x.submit(N);

    const zombieReached = deferred();
    const zombieGate = deferred();
    releaseAll.push(() => zombieGate.resolve());
    x.scriptExecute(async (input) => {
      if (input.job.delivery === 1) {
        x.write(input, 'zombie.txt', 'written by delivery 1\n');
        zombieReached.resolve();
        await zombieGate.promise; // stays in flight until the test releases it
        return ok('zombie result');
      }
      x.write(input, 'fresh.txt', 'written by delivery 2\n');
      return ok('fresh result');
    });
    x.scriptReview([{ verdict: 'approve', feedback: 'lgtm' }]);

    // Delivery 1 starts and blocks inside the runner (not awaited).
    const d1 = x.claim()!;
    expect(d1).toMatchObject({ id: job.id, delivery: 1 });
    const zombie: Promise<DeliveryOutcome> = x.deliver(d1);
    pending.push(zombie);
    await zombieReached.promise;

    // Its lease expires; the reaper (no-op kills) requeues the job.
    x.advance(LEASE_MS + 1);
    expect(x.reap()).toEqual({ requeued: [job.id], deadLettered: [], killed: [], errors: [] });

    // Delivery 2 and the review it creates run to completion.
    const outcomes = await x.runUntilIdle();
    expect(outcomes.map((o) => [o.jobId, o.type, o.delivery, o.outcome])).toEqual([
      [job.id, 'execute', 2, 'succeeded'],
      [job.id + 1, 'review', 1, 'succeeded'],
    ]);
    expect(x.chain(chain.id)).toMatchObject({ status: 'waiting', state: { phase: 'awaiting_merge' } });
    const before = published(x);
    const callsBefore = x.host.calls.length;
    const logBefore = x.workspaceLog.length;

    // While the zombie is still in flight, the review job's delivery-1 prepare neither removed nor
    // reused the zombie's delivery-1 worktree: same delivery number, different job.
    const zombieDir = join(x.workspaceRoot, String(chain.id), `j${job.id}-d1`);
    const reviewPrep = x.workspaceLog.find((e) => e.op === 'prepare' && e.type === 'review')!;
    expect(reviewPrep).toMatchObject({ jobId: job.id + 1, delivery: 1 });
    expect(reviewPrep.path).toBe(join(x.workspaceRoot, String(chain.id), `j${job.id + 1}-d1`));
    expect(reviewPrep.path).not.toBe(zombieDir);
    expect(existsSync(zombieDir)).toBe(true);
    expect(readFileSync(join(zombieDir, 'zombie.txt'), 'utf8')).toBe('written by delivery 1\n');

    // Now the zombie's runner returns its result.
    zombieGate.resolve();
    expect(await zombie).toBe('stale');

    // Its result and effects were rejected: nothing recorded, nothing published.
    expect(x.jobs(chain.id)[0]).toMatchObject({ status: 'succeeded', delivery: 2, result: { status: 'ok', summary: 'fresh result' } });
    expect(published(x)).toEqual(before);
    expect(x.host.calls.slice(callsBefore)).toEqual([]);
    expect(x.host.prs.size).toBe(1);
    expect(x.pr(BRANCH)).toEqual({ number: 8, state: 'open', labels: [READY], head: BRANCH });
    expect(x.chain(chain.id)).toMatchObject({ status: 'waiting', state: { phase: 'awaiting_merge', attempt: 1 } });

    // The remote branch holds only delivery 2's commit.
    expect(x.remoteFiles(BRANCH)).toEqual(['README.md', 'fresh.txt']);
    expect(x.remoteFile(BRANCH, 'zombie.txt')).toBeNull();
    expect(x.remoteLog(BRANCH)).toEqual([x.remoteHead(BRANCH), x.remoteHead('main')]);

    // The two deliveries used different workspaces and local branches.
    const [w1, w2] = x.callsOf('execute').map((c) => c.workspace as SoftwareWorkspace);
    expect(w1!.path).toBe(join(x.workspaceRoot, String(chain.id), `j${job.id}-d1`));
    expect(w2!.path).toBe(join(x.workspaceRoot, String(chain.id), `j${job.id}-d2`));
    expect(w1!.localBranch).toBe(`${BRANCH}-c${chain.id}-j${job.id}-d1`);
    expect(w2!.localBranch).toBe(`${BRANCH}-c${chain.id}-j${job.id}-d2`);
    expect(w2!.seedSha).toBe(w1!.seedSha); // both seeded from main: the zombie never published
    expect(w2!.remoteHeadSha).toBeNull();

    // The stale delivery's cleanup tore down only its own delivery-1 workspace, never delivery 2's.
    expect(x.workspaceLog.slice(logBefore)).toEqual([
      { op: 'teardown', jobId: job.id, type: 'execute', delivery: 1, outcome: 'ok', path: w1!.path },
    ]);
    expect(x.workspaceLog.filter((e) => e.op === 'teardown' && e.path === w2!.path)).toEqual([
      { op: 'teardown', jobId: job.id, type: 'execute', delivery: 2, outcome: 'ok', path: w2!.path },
    ]);
  });

  it('a crash after the result is recorded resumes without rerunning the runner', async () => {
    h = makeHarness();
    const x = h;
    const { chain } = await x.submit(N);
    x.scriptExecute((input) => {
      x.write(input, 'a.txt', 'a\n');
      return ok('done');
    });
    x.scriptReview([{ verdict: 'approve', feedback: 'lgtm' }]);

    expect(await x.runOne()).toMatchObject({ type: 'execute', outcome: 'succeeded' });

    // Delivery 1 of the review records its result, then "dies" inside its first set_labels effect.
    const hangReached = deferred();
    const hang = deferred();
    releaseAll.push(() => hang.resolve());
    let hung = false;
    x.beforeEffect = async (effect, ctx) => {
      if (!hung && ctx.job.type === 'review' && effect.kind === 'set_labels') {
        hung = true;
        hangReached.resolve();
        await hang.promise; // never released until the end: the process is gone
      }
    };
    const d1 = x.claim()!;
    expect(d1).toMatchObject({ type: 'review', delivery: 1, result: null });
    const crashed = x.deliver(d1);
    pending.push(crashed);
    await hangReached.promise;

    const recorded = x.jobs(chain.id).find((j) => j.type === 'review')!;
    expect(recorded).toMatchObject({ status: 'running', delivery: 1, result: { verdict: 'approve', feedback: 'lgtm' } });
    expect(x.pr(BRANCH)!.labels).toEqual([]);

    // The lease expires; the job is requeued with its recorded result.
    x.advance(LEASE_MS + 1);
    expect(x.reap()).toEqual({ requeued: [recorded.id], deadLettered: [], killed: [], errors: [] });

    const d2 = x.claim()!;
    expect(d2).toMatchObject({ id: recorded.id, delivery: 2, result: { verdict: 'approve', feedback: 'lgtm' } });
    expect(await x.deliver(d2)).toBe('succeeded');

    // The runner ran exactly once; delivery 2 reused the recorded result and prepared no workspace.
    expect(x.callsOf('review')).toHaveLength(1);
    expect(x.callsOf('execute')).toHaveLength(1);
    expect(x.workspaceLog.filter((e) => e.op === 'prepare').map((e) => [e.type, e.delivery])).toEqual([
      ['execute', 1],
      ['review', 1],
    ]);
    expect(x.jobs(chain.id).find((j) => j.type === 'review')).toMatchObject({
      status: 'succeeded',
      delivery: 2,
      result: { verdict: 'approve', feedback: 'lgtm' },
    });
    const c = x.chain(chain.id);
    expect(c.status).toBe('waiting');
    expect(c.state.phase).toBe('awaiting_merge');
    expect(x.pr(BRANCH)!.labels).toEqual([READY]);

    // Release the hung delivery: it finds itself stale and changes nothing.
    const before = published(x);
    hang.resolve();
    expect(await crashed).toBe('stale');
    expect(published(x)).toEqual(before);
    expect(x.callsOf('review')).toHaveLength(1);
    expect(existsSync(join(x.workspaceRoot, String(chain.id), `j${recorded.id}-d1`))).toBe(false);
  });
});
