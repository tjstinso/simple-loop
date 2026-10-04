import { existsSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitHostError } from '../../src/engines/software/github.js';
import { LABEL_DEAD_LETTER } from '../../src/engines/software/index.js';
import type { SoftwareWorkspace } from '../../src/engines/software/workspace.js';
import { DuplicateChainError } from '../../src/kernel/queue.js';
import type { RunInput } from '../../src/runner/types.js';
import { chainEvents } from '../../src/kernel/events.js';
import { FAKE_API_KEY, LEASE_MS, makeHarness, ok, type Harness, type HarnessOptions } from '../support/harness.js';

const N = 7;
const BRANCH = `factory/issue-${N}`;
const IN_PROGRESS = 'factory:in-progress';
const READY = 'factory:ready-for-merge';
const NEEDS_HUMAN = 'factory:needs-human';
const DAY = 86_400_000;

const harnesses: Harness[] = [];
const harness = (opts?: HarnessOptions): Harness => {
  const h = makeHarness(opts);
  harnesses.push(h);
  return h;
};
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

/** The issue's comments without the queued / started notices every chain gets. */
const outcomeComments = (h: Harness): string[] => h.comments(N).filter((c) => !/event=(queued|started) -->/.test(c));

const ws = (input: RunInput) => input.workspace as SoftwareWorkspace;

/** Delivery directories still on disk under the workspace root for a chain. */
function deliveryDirs(h: Harness, chainId: number): string[] {
  const dir = join(h.workspaceRoot, String(chainId));
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

/** Execute script: each call writes `attempt-<attempt>.txt` and succeeds. */
function writesPerAttempt(h: Harness) {
  h.scriptExecute((input) => {
    h.write(input, `attempt-${input.job.attempt}.txt`, `attempt ${input.job.attempt}\n`);
    return ok(`attempt ${input.job.attempt}`);
  });
}

/** Submit #N with an execute script that throws, and run until the chain is dead-lettered. */
async function driveToRunnerError(h: Harness) {
  const { chain } = await h.submit(N);
  h.scriptExecute(() => {
    throw new Error('agent crashed: segfault in tool');
  });
  h.scriptReview([{ verdict: 'approve', feedback: 'lgtm' }]);
  const outcomes = await h.runUntilIdle();
  return { chain, outcomes };
}

describe('software engine scenarios', () => {
  it('supervised happy path ends awaiting_merge with factory:ready-for-merge', async () => {
    const h = harness();
    const { chain } = await h.submit(N);
    h.scriptExecute((input) => {
      h.write(input, 'src/widget.ts', 'export const widget = 1;\n');
      return ok('implemented the widget');
    });
    h.scriptReview([{ verdict: 'approve', feedback: 'lgtm' }]);

    const outcomes = await h.runUntilIdle();

    expect(outcomes.map((o) => [o.type, o.attempt, o.delivery, o.outcome])).toEqual([
      ['execute', 1, 1, 'succeeded'],
      ['review', 1, 1, 'succeeded'],
    ]);
    const c = h.chain(chain.id);
    expect(c.status).toBe('waiting');
    expect(c.state.phase).toBe('awaiting_merge');
    expect(c.state.attempt).toBe(1);

    const pr = h.pr(BRANCH);
    expect(pr).toEqual({ number: 8, state: 'open', labels: [READY], head: BRANCH });
    expect(h.host.prs.get(8)!.body).toContain(`Closes #${N}`);
    expect(h.host.prs.get(8)!.body).toContain('implemented the widget');
    expect(h.issueLabels(N)).not.toContain(IN_PROGRESS);
    expect(h.issueLabels(N)).toEqual([]);

    expect(h.remoteBranches()).toEqual([BRANCH, 'main']);
    expect(h.remoteFile(BRANCH, 'src/widget.ts')).toBe('export const widget = 1;');
    expect(h.remoteFiles(BRANCH)).toEqual(['README.md', 'src/widget.ts']);
    expect(h.remoteLog(BRANCH)).toHaveLength(2); // initial + the factory commit

    expect(h.jobs(chain.id).map((j) => [j.type, j.attempt, j.status])).toEqual([
      ['execute', 1, 'succeeded'],
      ['review', 1, 'succeeded'],
    ]);
    expect(h.deadLetters()).toEqual([]);
    // Both delivery worktrees were torn down after success.
    expect(h.workspaceLog.filter((e) => e.op === 'teardown').map((e) => [e.type, e.delivery, e.outcome])).toEqual([
      ['execute', 1, 'ok'],
      ['review', 1, 'ok'],
    ]);
    expect(deliveryDirs(h, chain.id)).toEqual([]);
  });

  it('automatic happy path enables auto-merge, waits, then completes when the PR is merged', async () => {
    const h = harness();
    const { chain } = await h.submit(N, ['factory:profile:automatic']);
    writesPerAttempt(h);
    h.scriptReview([{ verdict: 'approve', feedback: 'ship it' }]);

    const outcomes = await h.runUntilIdle();

    expect(outcomes.map((o) => o.outcome)).toEqual(['succeeded', 'succeeded']);
    let c = h.chain(chain.id);
    expect(c.state.profile).toBe('automatic');
    expect(c.status).toBe('waiting');
    expect(c.state.phase).toBe('awaiting_merge');
    // The required checks have not passed: auto-merge is enabled, nothing is merged.
    expect(h.pr(BRANCH)).toMatchObject({ number: 8, state: 'open' });
    expect(h.host.autoMergeEnabled(8)).toBe(true);
    // Pinned to the head the reviewer saw (the review delivery's seed).
    expect(h.host.calls.filter((x) => x.method === 'mergePr').map((x) => x.args)).toEqual([
      ['o/r', 8, { expectHeadSha: h.remoteHead(BRANCH) }],
    ]);
    expect(chainEvents(h.db, chain.id).map((e) => e.kind)).toEqual(expect.arrayContaining(['merge.requested', 'merge.enabled']));
    expect(h.comments(8).filter((x) => x.includes('event=merge-enabled'))).toHaveLength(1);
    expect(h.issueLabels(N)).toEqual(['factory:profile:automatic']);
    expect(h.remoteFile(BRANCH, 'attempt-1.txt')).toBe('attempt 1');

    expect(await h.maintain()).toEqual([]);
    expect(h.chain(chain.id).status).toBe('waiting'); // still pending

    h.host.passRequiredChecks(); // GitHub merges the pull request
    expect(await h.maintain()).toEqual([]);
    c = h.chain(chain.id);
    expect(c.status).toBe('completed');
    expect(c.state.phase).toBe('merged');
    expect(h.pr(BRANCH)).toMatchObject({ number: 8, state: 'merged' });
    expect(deliveryDirs(h, chain.id)).toEqual([]);
  });

  it('automatic: a pull request closed without merging cancels the chain', async () => {
    const h = harness();
    const { chain } = await h.submit(N, ['factory:profile:automatic']);
    writesPerAttempt(h);
    h.scriptReview([{ verdict: 'approve', feedback: 'ship it' }]);
    await h.runUntilIdle();
    h.host.prs.get(8)!.state = 'closed';
    expect(await h.maintain()).toEqual([]);
    expect(h.chain(chain.id).status).toBe('cancelled');
  });

  it.each([
    ['the repository setting is off', (h: ReturnType<typeof harness>) => void (h.host.autoMergeAllowed = false)],
    [
      'the head moved after the review',
      (h: ReturnType<typeof harness>) => {
        h.beforeEffect = (effect) => {
          if (effect.kind === 'merge_pr') h.remote.commit(BRANCH, 'sneaky.txt', 'unreviewed\n');
        };
      },
    ],
  ])('automatic: when GitHub refuses auto-merge (%s) a person takes over', async (_why, refuse) => {
    const h = harness();
    const { chain } = await h.submit(N, ['factory:profile:automatic']);
    writesPerAttempt(h);
    h.scriptReview([{ verdict: 'approve', feedback: 'ship it' }]);
    refuse(h);

    const outcomes = await h.runUntilIdle();

    expect(outcomes.map((o) => [o.type, o.outcome])).toEqual([
      ['execute', 'succeeded'],
      ['review', 'succeeded'],
    ]);
    const c = h.chain(chain.id);
    expect(c.status).toBe('waiting');
    expect(c.state.phase).toBe('needs_human');
    expect(h.deadLetters()).toEqual([]);
    expect(h.issueLabels(N)).toContain('factory:needs-human');
    expect(h.issueLabels(N)).not.toContain(IN_PROGRESS);
    expect(h.pr(BRANCH)).toMatchObject({ state: 'open' });
    expect(h.host.autoMergeEnabled(8)).toBe(false);
    expect(h.comments(8)).toHaveLength(1);
    expect(h.comments(8)[0]).toContain('a person has to merge');
    expect(chainEvents(h.db, chain.id).map((e) => e.kind)).not.toContain('merge.enabled');

    // A person merges: the reconcile hook completes the chain.
    h.host.markMerged(8);
    expect(await h.maintain()).toEqual([]);
    expect(h.chain(chain.id).status).toBe('completed');
  });

  it('after a refused pinned merge, dlq retry re-reviews the current head before merging', async () => {
    const h = harness();
    const { chain } = await h.submit(N, ['factory:profile:automatic']);
    writesPerAttempt(h);
    let pushed: string | null = null;
    h.scriptReview(() => ({ verdict: 'approve', feedback: 'ship it' }));
    h.beforeEffect = (effect) => {
      if (effect.kind === 'merge_pr' && pushed === null) {
        h.remote.commit(BRANCH, 'sneaky.txt', 'unreviewed\n'); // lands after the review, before the merge
        pushed = h.remoteHead(BRANCH);
        // A refusal other than the typed auto-merge ones (e.g. a conflict): the review is redone.
        h.host.failNext('mergePr', new GitHostError('Pull Request is not mergeable', 405));
      }
    };

    const first = await h.runUntilIdle();
    expect(first.map((o) => [o.type, o.outcome])).toEqual([
      ['execute', 'succeeded'],
      ['review', 'dead_lettered'],
    ]);
    const review = h.jobs(chain.id).find((j) => j.type === 'review')!;
    const reviewedHead = ws(h.callsOf('review')[0]!).seedSha;
    expect(pushed).not.toBeNull();
    expect(reviewedHead).not.toBe(pushed);
    expect(h.deadLetters()).toEqual([
      expect.objectContaining({
        jobId: review.id,
        reason: 'runner_error',
        error: "effect 'merge_pr' failed: merge refused for the reviewed head: Pull Request is not mergeable",
      }),
    ]);
    expect(h.pr(BRANCH)).toMatchObject({ state: 'open' });

    const retried = await h.kernel.retryDeadLetter(review.id);
    expect(retried).toMatchObject({ status: 'queued', result: null }); // the verdict is not kept
    const second = await h.runUntilIdle();

    expect(second.map((o) => [o.type, o.outcome])).toEqual([['review', 'succeeded']]);
    const reviews = h.callsOf('review');
    expect(reviews).toHaveLength(2);
    expect(ws(reviews[1]!).seedSha).toBe(pushed);
    expect(h.host.calls.filter((x) => x.method === 'mergePr').map((x) => x.args)).toEqual([
      ['o/r', 8, { expectHeadSha: reviewedHead }],
      ['o/r', 8, { expectHeadSha: pushed }],
    ]);
    expect(h.host.autoMergeEnabled(8)).toBe(true);
    expect(h.chain(chain.id)).toMatchObject({ status: 'waiting', state: { phase: 'awaiting_merge' } });
  });

  it('a review resumed without its workspace never merges unpinned: it dead-letters runner_error', async () => {
    const h = harness();
    const { chain } = await h.submit(N, ['factory:profile:automatic']);
    writesPerAttempt(h);
    h.scriptReview(() => ({ verdict: 'approve', feedback: 'ship it' }));
    let failed = false;
    h.beforeEffect = (effect) => {
      if (effect.kind === 'merge_pr' && !failed) {
        failed = true;
        h.host.failNext('findPrByHead', new GitHostError('Validation Failed', 422)); // a non-retryable effect_error
      }
    };

    const first = await h.runUntilIdle();
    expect(first.map((o) => [o.type, o.outcome])).toEqual([
      ['execute', 'succeeded'],
      ['review', 'dead_lettered'],
    ]);
    const review = h.jobs(chain.id).find((j) => j.type === 'review')!;
    expect(h.deadLetters()).toEqual([expect.objectContaining({ jobId: review.id, reason: 'effect_error' })]);

    // effect_error retry keeps the verdict: post-processing resumes without a workspace.
    await h.kernel.retryDeadLetter(review.id);
    const second = await h.runUntilIdle();
    expect(second.map((o) => [o.type, o.outcome])).toEqual([['review', 'dead_lettered']]);
    expect(h.callsOf('review')).toHaveLength(1);
    expect(h.host.calls.filter((x) => x.method === 'mergePr')).toEqual([]);
    expect(h.pr(BRANCH)).toMatchObject({ state: 'open' });
    expect(h.deadLetters().filter((d) => d.resolvedAt === null)).toEqual([
      expect.objectContaining({
        jobId: review.id,
        reason: 'runner_error',
        error: "effect 'merge_pr' failed: cannot verify the reviewed head; the review will be redone",
      }),
    ]);

    // runner_error retry: the review runs again and the merge is pinned to what it saw.
    await h.kernel.retryDeadLetter(review.id);
    const third = await h.runUntilIdle();
    expect(third.map((o) => [o.type, o.outcome])).toEqual([['review', 'succeeded']]);
    expect(h.callsOf('review')).toHaveLength(2);
    expect(h.host.calls.filter((x) => x.method === 'mergePr').map((x) => x.args)).toEqual([
      ['o/r', 8, { expectHeadSha: h.remoteHead(BRANCH) }],
    ]);
    expect(h.host.autoMergeEnabled(8)).toBe(true);
    expect(h.chain(chain.id)).toMatchObject({ status: 'waiting', state: { phase: 'awaiting_merge' } });
  });

  it('revise loop: two request_changes then approve', async () => {
    const h = harness();
    const { chain } = await h.submit(N);
    writesPerAttempt(h);
    // Each review records the remote head it reviewed: that is what the previous execute pushed.
    const pushed: string[] = [];
    const verdicts = [
      { verdict: 'request_changes', feedback: 'please add tests' },
      { verdict: 'request_changes', feedback: 'tests are still missing an edge case' },
      { verdict: 'approve', feedback: 'lgtm' },
    ];
    h.scriptReview((input, call) => {
      pushed.push(h.remoteHead(BRANCH)!);
      expect(ws(input).seedSha).toBe(h.remoteHead(BRANCH)); // review is seeded from the PR head
      return verdicts[call];
    });
    const mainHead = h.remoteHead('main')!;

    const outcomes = await h.runUntilIdle();

    expect(outcomes.map((o) => [o.type, o.attempt, o.outcome])).toEqual([
      ['execute', 1, 'succeeded'],
      ['review', 1, 'succeeded'],
      ['execute', 2, 'succeeded'],
      ['review', 2, 'succeeded'],
      ['execute', 3, 'succeeded'],
      ['review', 3, 'succeeded'],
    ]);
    const c = h.chain(chain.id);
    expect(c.state.attempt).toBe(3);
    expect(c.state.phase).toBe('awaiting_merge');
    expect(c.status).toBe('waiting');

    const execs = h.callsOf('execute');
    expect(execs.map((x) => x.job.attempt)).toEqual([1, 2, 3]);
    expect(h.callsOf('review')).toHaveLength(3);
    // Revise executes carry the reviewer's feedback in their run input (and payload).
    expect(execs.map((x) => x.feedback)).toEqual([undefined, 'please add tests', 'tests are still missing an edge case']);
    expect(execs.map((x) => x.job.payload)).toEqual([
      null,
      { feedback: 'please add tests' },
      { feedback: 'tests are still missing an edge case' },
    ]);
    // Attempt 1 is seeded from main; each revise from the previously pushed head.
    expect(ws(execs[0]!).seedSha).toBe(mainHead);
    expect(ws(execs[0]!).remoteHeadSha).toBeNull();
    expect(ws(execs[1]!).seedSha).toBe(pushed[0]);
    expect(ws(execs[1]!).remoteHeadSha).toBe(pushed[0]);
    expect(ws(execs[2]!).seedSha).toBe(pushed[1]);
    expect(ws(execs[2]!).remoteHeadSha).toBe(pushed[1]);
    expect(new Set(pushed).size).toBe(3);

    // Remote history: three factory commits in order on top of main.
    expect(h.remoteLog(BRANCH)).toEqual([pushed[2], pushed[1], pushed[0], mainHead]);
    expect(h.remoteFiles(BRANCH)).toEqual(['README.md', 'attempt-1.txt', 'attempt-2.txt', 'attempt-3.txt']);
    // One PR for the whole loop.
    expect(h.host.prs.size).toBe(1);
    expect(h.pr(BRANCH)).toEqual({ number: 8, state: 'open', labels: [READY], head: BRANCH });
  });

  it('revise loop exhausts at 3 attempts and ends needs_human with the PR open', async () => {
    const h = harness();
    const { chain } = await h.submit(N);
    writesPerAttempt(h);
    h.scriptReview([
      { verdict: 'request_changes', feedback: 'no 1' },
      { verdict: 'request_changes', feedback: 'no 2' },
      { verdict: 'request_changes', feedback: 'no 3' },
    ]);

    const outcomes = await h.runUntilIdle();

    expect(outcomes).toHaveLength(6);
    expect(outcomes.every((o) => o.outcome === 'succeeded')).toBe(true);
    const c = h.chain(chain.id);
    expect(c.status).toBe('waiting');
    expect(c.state.phase).toBe('needs_human');
    expect(c.state.attempt).toBe(3);
    expect(h.callsOf('execute')).toHaveLength(3);
    expect(h.callsOf('review')).toHaveLength(3);
    expect(h.jobs(chain.id).map((j) => `${j.type}:${j.attempt}:${j.status}`)).toEqual([
      'execute:1:succeeded', 'review:1:succeeded',
      'execute:2:succeeded', 'review:2:succeeded',
      'execute:3:succeeded', 'review:3:succeeded',
    ]);
    expect(h.pr(BRANCH)).toEqual({ number: 8, state: 'open', labels: [NEEDS_HUMAN], head: BRANCH });
    expect(h.issueLabels(N)).toEqual([]);
    expect(h.deadLetters()).toEqual([]);
  });

  it('runner error lands in the DLQ, labels the issue and keeps the worktree', async () => {
    const h = harness();
    const { chain, outcomes } = await driveToRunnerError(h);

    expect(outcomes.map((o) => [o.type, o.delivery, o.outcome])).toEqual([['execute', 1, 'dead_lettered']]);
    expect(h.chain(chain.id).status).toBe('dead_lettered');
    const [job] = h.jobs(chain.id);
    expect(h.jobs(chain.id)).toHaveLength(1);
    expect(job).toMatchObject({ type: 'execute', status: 'failed', delivery: 1, result: null });
    expect(h.deadLetters()).toEqual([
      expect.objectContaining({ jobId: job!.id, chainId: chain.id, reason: 'runner_error', error: 'agent crashed: segfault in tool', resolvedAt: null }),
    ]);

    expect(h.issueLabels(N)).toEqual([LABEL_DEAD_LETTER]);
    const marker = `<!-- factory:chain=${chain.id} job=${job!.id} event=dead-letter -->`;
    const comments = outcomeComments(h);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain(marker);
    expect(comments[0]).toContain('runner_error');
    expect(comments[0]).toContain('agent crashed: segfault in tool');

    // Nothing was published.
    expect(h.host.prs.size).toBe(0);
    expect(h.remoteBranches()).toEqual(['main']);
    // The failed delivery's worktree is kept on disk for debugging.
    const kept = join(h.workspaceRoot, String(chain.id), `j${h.jobs(chain.id)[0]!.id}-d1`);
    expect(h.workspaceLog.at(-1)).toEqual({ op: 'teardown', jobId: job!.id, type: 'execute', delivery: 1, outcome: 'failed', path: kept });
    expect(existsSync(join(kept, 'README.md'))).toBe(true);
  });

  it('an agent that writes the worker API key into its worktree is dead-lettered and nothing is published', async () => {
    const h = harness();
    const { chain } = await h.submit(N);
    h.scriptExecute((input) => {
      h.write(input, 'secret.txt', `ANTHROPIC_API_KEY=${FAKE_API_KEY}\n`);
      return ok('wrote the key as the issue asked');
    });
    h.scriptReview([{ verdict: 'approve', feedback: 'lgtm' }]);

    const outcomes = await h.runUntilIdle();

    expect(outcomes.map((o) => [o.type, o.delivery, o.outcome])).toEqual([['execute', 1, 'dead_lettered']]);
    expect(h.chain(chain.id).status).toBe('dead_lettered');
    const [job] = h.jobs(chain.id);
    const dls = h.deadLetters();
    expect(dls).toEqual([
      expect.objectContaining({
        jobId: job!.id,
        reason: 'runner_error',
        error: "effect 'commit_push' failed: refusing to push: the change contains a secret (anthropic-key, known-secret-value); the matched text is not shown",
      }),
    ]);
    // Never pushed, no PR.
    expect(h.remoteBranches()).toEqual(['main']);
    expect(h.host.prs.size).toBe(0);
    expect(h.host.calls.map((c) => c.method)).not.toContain('openPr');
    // The worktree is kept for inspection, secret and all.
    const kept = join(h.workspaceRoot, String(chain.id), `j${job!.id}-d1`);
    expect(existsSync(join(kept, 'secret.txt'))).toBe(true);
    // The key appears nowhere the factory wrote to.
    const row = h.db.prepare('SELECT * FROM dead_letters').all();
    expect(JSON.stringify(row)).not.toContain(FAKE_API_KEY);
    expect(JSON.stringify(dls)).not.toContain(FAKE_API_KEY);
    expect(outcomeComments(h).join('\n')).not.toContain(FAKE_API_KEY);
    expect(outcomeComments(h).join('\n')).toContain('known-secret-value');
    expect(JSON.stringify(h.host.calls)).not.toContain(FAKE_API_KEY);
  });

  it('an execute error summary holding the API key reaches the dead letter and the issue redacted', async () => {
    const h = harness();
    await h.submit(N);
    h.scriptExecute(() => ({ status: 'error', summary: `could not authenticate with ${FAKE_API_KEY}` }));
    await h.runUntilIdle();
    expect(h.deadLetters()).toEqual([
      expect.objectContaining({ reason: 'runner_error', error: 'transition failed: could not authenticate with [redacted]' }),
    ]);
    expect(outcomeComments(h).join('\n')).toContain('could not authenticate with [redacted]');
    expect(JSON.stringify(h.db.prepare('SELECT * FROM dead_letters').all())).not.toContain(FAKE_API_KEY);
    expect(JSON.stringify(h.host.calls)).not.toContain(FAKE_API_KEY);
  });

  it('dlq retry resumes and completes', async () => {
    const h = harness();
    const { chain } = await driveToRunnerError(h);
    const [failed] = h.jobs(chain.id);
    const kept = join(h.workspaceRoot, String(chain.id), `j${h.jobs(chain.id)[0]!.id}-d1`);
    expect(existsSync(kept)).toBe(true);

    // A sweep keeps a recent dead letter's worktree ...
    await h.engine.sweep!(h.clock());
    expect(existsSync(kept)).toBe(true);
    // ... and removes it once it is older than keptWorktreeMaxAgeMs (default 7 days).
    h.advance(7 * DAY + 1);
    await h.engine.sweep!(h.clock());
    expect(existsSync(kept)).toBe(false);
    expect(deliveryDirs(h, chain.id)).toEqual([]);

    // Fix the agent, retry the dead letter, run to completion.
    expect(h.issueLabels(N)).toEqual([LABEL_DEAD_LETTER]);
    const labelsDuringRun: string[][] = [];
    h.scriptExecute((input) => {
      labelsDuringRun.push(h.issueLabels(N));
      h.write(input, `attempt-${input.job.attempt}.txt`, `attempt ${input.job.attempt}\n`);
      return ok(`attempt ${input.job.attempt}`);
    });
    const retried = await h.kernel.retryDeadLetter(failed!.id);
    expect(retried).toMatchObject({ id: failed!.id, status: 'queued', delivery: 1, result: null, error: null });
    expect(h.chain(chain.id).status).toBe('active');
    // The engine's afterRetry hook took the issue out of the dead-letter state.
    expect(h.issueLabels(N)).toEqual([IN_PROGRESS]);

    const outcomes = await h.runUntilIdle();

    expect(labelsDuringRun).toEqual([[IN_PROGRESS]]);
    expect(h.issueLabels(N)).not.toContain(LABEL_DEAD_LETTER);
    expect(h.issueLabels(N)).toEqual([]);

    expect(outcomes.map((o) => [o.type, o.attempt, o.delivery, o.outcome])).toEqual([
      ['execute', 1, 2, 'succeeded'],
      ['review', 1, 1, 'succeeded'],
    ]);
    const c = h.chain(chain.id);
    expect(c.status).toBe('waiting');
    expect(c.state.phase).toBe('awaiting_merge');
    expect(h.pr(BRANCH)).toEqual({ number: 8, state: 'open', labels: [READY], head: BRANCH });
    expect(h.remoteFile(BRANCH, 'attempt-1.txt')).toBe('attempt 1');
    expect(h.callsOf('execute')).toHaveLength(2); // the failed run and the retry
    expect(h.callsOf('review')).toHaveLength(1);
    expect(h.deadLetters()).toEqual([expect.objectContaining({ jobId: failed!.id, resolvedAt: expect.any(Number) })]);
    expect(h.jobs(chain.id).map((j) => [j.type, j.status, j.delivery])).toEqual([
      ['execute', 'succeeded', 2],
      ['review', 'succeeded', 1],
    ]);
    expect(deliveryDirs(h, chain.id)).toEqual([]);
  });

  it('three lease expiries dead-letter with max_deliveries', async () => {
    const h = harness();
    const { chain, job } = await h.submit(N);

    for (const delivery of [1, 2]) {
      const claimed = h.claim();
      expect(claimed).toMatchObject({ id: job.id, delivery, status: 'running', leaseExpiresAt: h.clock() + LEASE_MS });
      h.advance(LEASE_MS + 1);
      expect(h.reap()).toEqual({ requeued: [job.id], deadLettered: [], killed: [], errors: [] });
      expect(h.jobs(chain.id)[0]).toMatchObject({ status: 'queued', delivery });
    }
    const third = h.claim();
    expect(third).toMatchObject({ id: job.id, delivery: 3 });
    // Not yet expired: nothing happens.
    h.advance(LEASE_MS);
    expect(h.reap()).toEqual({ requeued: [], deadLettered: [], killed: [], errors: [] });
    h.advance(1);
    const deadAt = h.clock();
    // Kernel maintenance reaps the third expiry and surfaces the dead letter through the engine.
    expect(await h.maintain()).toEqual([]);

    expect(h.deadLetters()).toEqual([
      {
        id: expect.any(Number),
        jobId: job.id,
        chainId: chain.id,
        reason: 'max_deliveries',
        error: `job ${job.id} lease expired on delivery 3 (max 3)`,
        createdAt: deadAt,
        resolvedAt: null,
        surfacedAt: deadAt,
      },
    ]);
    expect(h.jobs(chain.id)).toEqual([expect.objectContaining({ status: 'failed', delivery: 3 })]);
    expect(h.chain(chain.id).status).toBe('dead_lettered');
    expect(h.claim()).toBeNull();
    expect(h.runner.calls).toHaveLength(0);
    expect(h.issueLabels(N)).toEqual([LABEL_DEAD_LETTER]);
    const comments = outcomeComments(h);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain(`<!-- factory:chain=${chain.id} job=${job.id} event=dead-letter -->`);
    expect(comments[0]).toContain('max_deliveries');
  });

  it('followups are filed as issues and not queued', async () => {
    const h = harness();
    const { chain } = await h.submit(N);
    h.scriptExecute((input) => {
      h.write(input, 'a.txt', 'a\n');
      return ok('done', [
        { title: 'Refactor the widget factory', body: 'It is tangled.' },
        { title: 'Add docs for widgets', body: 'None exist.' },
      ]);
    });
    h.scriptReview([{ verdict: 'approve', feedback: 'lgtm' }]);

    await h.runUntilIdle();

    const followups = [...h.host.issues.values()].filter((i) => h.host.getLabels(i.number).includes('factory:followup'));
    expect(followups.map((i) => [i.number, i.title, i.state])).toEqual([
      [9, 'Refactor the widget factory', 'open'],
      [10, 'Add docs for widgets', 'open'],
    ]);
    for (const [i, f] of followups.entries()) {
      expect(f.body).toContain(`Discovered while working on #${N}.`);
      expect(f.body).toContain(`<!-- factory:chain=${chain.id} job=${h.jobs(chain.id)[0]!.id} followup=${i} -->`);
      expect(h.host.getLabels(f.number)).toEqual(['factory:followup']);
    }
    const rows = h.db.prepare('SELECT position, filed_issue_number FROM followups ORDER BY position').all();
    expect(rows).toEqual([
      { position: 0, filed_issue_number: 9 },
      { position: 1, filed_issue_number: 10 },
    ]);
    // Not queued: only the original chain and its two jobs exist.
    const chains = h.db.prepare('SELECT id, subject_key FROM chains').all();
    expect(chains).toEqual([{ id: chain.id, subject_key: `o/r#${N}` }]);
    expect(h.jobs().map((j) => [j.chainId, j.type])).toEqual([
      [chain.id, 'execute'],
      [chain.id, 'review'],
    ]);
    expect(h.chain(chain.id).state.phase).toBe('awaiting_merge');
  });

  it('cancel ends a waiting chain, clears its issue labels, and the same issue can be resubmitted', async () => {
    const h = harness();
    const url = `https://github.com/o/r/issues/${N}`;
    const { chain } = await h.submit(N);
    writesPerAttempt(h);
    h.scriptReview([
      { verdict: 'request_changes', feedback: 'a' },
      { verdict: 'request_changes', feedback: 'b' },
      { verdict: 'request_changes', feedback: 'c' },
    ]);
    await h.runUntilIdle();
    expect(h.chain(chain.id)).toMatchObject({ status: 'waiting', state: { phase: 'needs_human' } });
    await expect(h.kernel.enqueue('software', { issueUrl: url })).rejects.toBeInstanceOf(DuplicateChainError);

    await h.kernel.cancelChain(chain.id);
    expect(h.chain(chain.id).status).toBe('cancelled');
    expect(h.issueLabels(N)).toEqual([]);

    const again = await h.kernel.enqueue('software', { issueUrl: url });
    expect(again.chain.id).not.toBe(chain.id);
    expect(again.chain.status).toBe('active');
    h.scriptReview([{ verdict: 'approve', feedback: 'ok now' }]);
    await h.runUntilIdle();
    expect(h.chain(again.chain.id)).toMatchObject({ status: 'waiting', state: { phase: 'awaiting_merge' } });
  });

  it('closing the issue stops the chain: the next job dead-letters before the agent runs', async () => {
    const h = harness();
    const { chain } = await h.submit(N);
    writesPerAttempt(h);
    h.scriptReview([{ verdict: 'request_changes', feedback: 'more' }]);
    await h.runOne(); // execute attempt 1
    await h.runOne(); // review requests changes: execute attempt 2 is queued
    h.host.issues.get(N)!.state = 'closed';
    const rec = await h.runOne();
    expect(rec).toMatchObject({ type: 'execute', attempt: 2, outcome: 'dead_lettered' });
    expect(h.callsOf('execute')).toHaveLength(1);
    expect(h.deadLetters()).toEqual([expect.objectContaining({ reason: 'runner_error', error: `issue #${N} is closed` })]);
    expect(h.chain(chain.id).status).toBe('dead_lettered');
  });

  it('a second submit for an open chain is rejected', async () => {
    const h = harness();
    const { chain } = await h.submit(N);
    await expect(h.kernel.enqueue('software', { issueUrl: `https://github.com/o/r/issues/${N}` })).rejects.toBeInstanceOf(
      DuplicateChainError,
    );
    expect(h.db.prepare('SELECT id FROM chains').all()).toEqual([{ id: chain.id }]);
    expect(h.jobs()).toHaveLength(1);
  });

  it('review job is not claimable until the PR exists', async () => {
    // (a) at the moment the PR is opened, the chain has no review job yet.
    const h = harness();
    const { chain } = await h.submit(N);
    writesPerAttempt(h);
    h.scriptReview([{ verdict: 'approve', feedback: 'lgtm' }]);
    const reviewJobsAtOpen: number[] = [];
    const openPr = h.host.openPr.bind(h.host);
    h.host.openPr = async (repo, a) => {
      reviewJobsAtOpen.push(h.jobs(chain.id).filter((j) => j.type === 'review').length);
      return openPr(repo, a);
    };
    await h.runUntilIdle();
    expect(reviewJobsAtOpen).toEqual([0]);
    expect(h.jobs(chain.id).map((j) => [j.type, j.status])).toEqual([
      ['execute', 'succeeded'],
      ['review', 'succeeded'],
    ]);

    // (b) when opening the PR fails, the execute job dead-letters and no follow-on job exists.
    const h2 = harness();
    const second = await h2.submit(N);
    writesPerAttempt(h2);
    h2.scriptReview([{ verdict: 'approve', feedback: 'lgtm' }]);
    h2.host.failNext('openPr', new GitHostError('Validation Failed', 422));

    const outcomes = await h2.runUntilIdle();

    expect(outcomes.map((o) => [o.type, o.outcome])).toEqual([['execute', 'dead_lettered']]);
    expect(h2.deadLetters()).toEqual([
      // R33: an execute job's open_pr failure is a runner_error, so one retry reruns the agent.
      expect.objectContaining({ chainId: second.chain.id, reason: 'runner_error', error: "effect 'open_pr' failed: Validation Failed" }),
    ]);
    expect(h2.jobs()).toEqual([expect.objectContaining({ type: 'execute', status: 'failed' })]);
    expect(h2.chain(second.chain.id).status).toBe('dead_lettered');
    expect(h2.host.prs.size).toBe(0);
    expect(h2.callsOf('review')).toHaveLength(0);
  });

  it('dlq retry after effect_error keeps the result and does not rerun the runner', async () => {
    const h = harness();
    const { chain } = await h.submit(N);
    writesPerAttempt(h);
    // The review's first label write is refused (non-retryable 422).
    h.scriptReview(() => {
      h.host.failNext('setLabels', new GitHostError('Validation Failed', 422));
      return { verdict: 'approve', feedback: 'lgtm' };
    });

    const first = await h.runUntilIdle();
    expect(first.map((o) => [o.type, o.outcome])).toEqual([
      ['execute', 'succeeded'],
      ['review', 'dead_lettered'],
    ]);
    const review = h.jobs(chain.id).find((j) => j.type === 'review')!;
    expect(review).toMatchObject({ status: 'failed', delivery: 1, result: { verdict: 'approve', feedback: 'lgtm' } });
    expect(h.deadLetters()).toEqual([
      expect.objectContaining({ jobId: review.id, reason: 'effect_error', error: "effect 'set_labels' failed: Validation Failed" }),
    ]);
    expect(h.pr(BRANCH)!.labels).toEqual([]);

    expect(h.issueLabels(N)).toEqual([LABEL_DEAD_LETTER]);
    // Through the kernel, as `factory dlq retry` does: the engine's afterRetry hook runs too.
    const retried = await h.kernel.retryDeadLetter(review.id);
    expect(retried).toMatchObject({ status: 'queued', result: { verdict: 'approve', feedback: 'lgtm' } });
    expect(h.issueLabels(N)).toEqual([IN_PROGRESS]);

    const second = await h.runUntilIdle();

    expect(second.map((o) => [o.type, o.delivery, o.outcome])).toEqual([['review', 2, 'succeeded']]);
    expect(h.callsOf('review')).toHaveLength(1);
    expect(h.callsOf('execute')).toHaveLength(1);
    // The resumed delivery never prepared a workspace: it went straight to post-processing.
    expect(h.workspaceLog.filter((e) => e.op === 'prepare').map((e) => [e.type, e.delivery])).toEqual([
      ['execute', 1],
      ['review', 1],
    ]);
    const c = h.chain(chain.id);
    expect(c.status).toBe('waiting');
    expect(c.state.phase).toBe('awaiting_merge');
    expect(h.pr(BRANCH)!.labels).toEqual([READY]);
    expect(h.issueLabels(N)).toEqual([]);
  });

  it('dlq retry after a push failure on an execute job reruns the agent and completes', async () => {
    const h = harness();
    const { chain } = await h.submit(N);
    writesPerAttempt(h);
    h.scriptReview([{ verdict: 'approve', feedback: 'lgtm' }]);
    // The remote is unreachable while the first delivery pushes.
    const away = `${h.remote.path}.away`;
    let failed = false;
    h.beforeEffect = (effect) => {
      if (effect.kind === 'commit_push' && !failed) {
        failed = true;
        renameSync(h.remote.path, away);
      }
    };

    const first = await h.runUntilIdle();
    renameSync(away, h.remote.path);
    expect(first.map((o) => [o.type, o.delivery, o.outcome])).toEqual([['execute', 1, 'dead_lettered']]);
    const [execute] = h.jobs(chain.id);
    expect(h.deadLetters()).toEqual([
      expect.objectContaining({ jobId: execute!.id, reason: 'runner_error', error: expect.stringMatching(/^effect 'commit_push' failed: git push failed/) }),
    ]);
    // A runner_error retry clears the result: the agent reruns in a fresh workspace.
    const retried = await h.kernel.retryDeadLetter(execute!.id);
    expect(retried).toMatchObject({ status: 'queued', result: null });

    const second = await h.runUntilIdle();

    expect(second.map((o) => [o.type, o.delivery, o.outcome])).toEqual([
      ['execute', 2, 'succeeded'],
      ['review', 1, 'succeeded'],
    ]);
    expect(h.callsOf('execute')).toHaveLength(2);
    expect(h.chain(chain.id)).toMatchObject({ status: 'waiting', state: { phase: 'awaiting_merge' } });
    expect(h.remoteFile(BRANCH, 'attempt-1.txt')).toBe('attempt 1');
    expect(h.pr(BRANCH)!.labels).toEqual([READY]);
    expect(h.issueLabels(N)).toEqual([]);
  });
  describe('reconcile of waiting chains', () => {
    const MERGED_COMMENT = 'Pull request #8 was merged';
    const CLOSED_COMMENT = 'Pull request #8 was closed without merging; this chain was cancelled';

    async function driveToWaiting(h: Harness, verdicts: 'approve' | 'reject') {
      const { chain } = await h.submit(N);
      writesPerAttempt(h);
      h.scriptReview(
        verdicts === 'approve'
          ? [{ verdict: 'approve', feedback: 'lgtm' }]
          : [1, 2, 3].map((i) => ({ verdict: 'request_changes' as const, feedback: `no ${i}` })),
      );
      await h.runUntilIdle();
      expect(h.chain(chain.id).status).toBe('waiting');
      // Stale factory labels a human might see on the issue.
      await h.host.setLabels('o/r', N, [IN_PROGRESS, READY, NEEDS_HUMAN, LABEL_DEAD_LETTER], []);
      return chain;
    }

    it('completes a chain whose pull request was merged, once', async () => {
      const h = harness();
      const chain = await driveToWaiting(h, 'approve');
      h.host.prs.get(8)!.state = 'merged';

      expect(await h.maintain()).toEqual([]);

      expect(h.chain(chain.id)).toMatchObject({ status: 'completed', state: { phase: 'merged' } });
      expect(h.issueLabels(N)).toEqual([]);
      expect(outcomeComments(h)).toHaveLength(1);
      expect(outcomeComments(h)[0]).toContain(MERGED_COMMENT);

      const lookups = h.host.calls.length;
      expect(await h.maintain()).toEqual([]);
      expect(h.host.calls.length).toBe(lookups); // a completed chain is not looked at again
      expect(h.chain(chain.id).status).toBe('completed');
      expect(outcomeComments(h)).toHaveLength(1);
    });

    it('cancels a chain whose pull request was closed without merging', async () => {
      const h = harness();
      const chain = await driveToWaiting(h, 'approve');
      h.host.prs.get(8)!.state = 'closed';

      expect(await h.maintain()).toEqual([]);

      expect(h.chain(chain.id).status).toBe('cancelled');
      expect(h.issueLabels(N)).toEqual([]);
      expect(outcomeComments(h)).toHaveLength(1);
      expect(outcomeComments(h)[0]).toContain(CLOSED_COMMENT);
      await h.maintain();
      expect(outcomeComments(h)).toHaveLength(1);
    });

    it('completes a needs_human chain whose pull request was merged', async () => {
      const h = harness();
      const chain = await driveToWaiting(h, 'reject');
      expect(h.chain(chain.id).state.phase).toBe('needs_human');
      h.host.prs.get(8)!.state = 'merged';

      expect(await h.maintain()).toEqual([]);

      expect(h.chain(chain.id)).toMatchObject({ status: 'completed', state: { phase: 'merged' } });
      expect(h.issueLabels(N)).toEqual([]);
      expect(outcomeComments(h)).toHaveLength(1);
    });

    it('leaves a chain with an open pull request untouched', async () => {
      const h = harness();
      const chain = await driveToWaiting(h, 'approve');
      expect(await h.maintain()).toEqual([]);
      expect(h.chain(chain.id)).toMatchObject({ status: 'waiting', state: { phase: 'awaiting_merge' } });
      expect(h.issueLabels(N)).toContain(READY);
      expect(outcomeComments(h)).toEqual([]);
    });

    it('leaves a chain waiting on a transient host error and settles it on the next pass', async () => {
      const h = harness();
      const chain = await driveToWaiting(h, 'approve');
      h.host.prs.get(8)!.state = 'merged';
      h.host.failNext('findPrByHead', new GitHostError('bad gateway', 502));

      expect(await h.maintain()).toEqual([]);
      expect(h.chain(chain.id).status).toBe('waiting');

      expect(await h.maintain()).toEqual([]);
      expect(h.chain(chain.id).status).toBe('completed');
    });

    it('reports a label failure and keeps the transition', async () => {
      const h = harness();
      const chain = await driveToWaiting(h, 'approve');
      h.host.prs.get(8)!.state = 'merged';
      h.host.failNext('setLabels', new GitHostError('forbidden', 403));

      const errors = await h.maintain();

      expect(errors).toHaveLength(1);
      expect(h.chain(chain.id).status).toBe('completed');
      expect(outcomeComments(h)).toHaveLength(1); // the comment was still attempted
    });

    it('lets the same issue be submitted again after reconcile completed its chain', async () => {
      const h = harness();
      const chain = await driveToWaiting(h, 'approve');
      await expect(h.submit(N)).rejects.toBeInstanceOf(DuplicateChainError);
      h.host.prs.get(8)!.state = 'merged';
      await h.maintain();
      expect(h.chain(chain.id).status).toBe('completed');

      const again = await h.submit(N);
      expect(again.chain.id).not.toBe(chain.id);
      expect(h.chain(again.chain.id).status).toBe('active');
    });
  });
});
