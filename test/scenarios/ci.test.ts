import { afterEach, describe, expect, it } from 'vitest';
import { GitHostError, type CheckInfo } from '../../src/engines/software/github.js';
import { chainEvents } from '../../src/kernel/events.js';
import { makeHarness, ok, type Harness, type HarnessOptions } from '../support/harness.js';

const N = 7;
const BRANCH = `factory/issue-${N}`;
const READY = 'factory:ready-for-merge';
const IN_PROGRESS = 'factory:in-progress';
const NEEDS_HUMAN = 'factory:needs-human';

const harnesses: Harness[] = [];
const harness = (opts?: HarnessOptions): Harness => {
  const h = makeHarness(opts);
  harnesses.push(h);
  return h;
};
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

const at = (h: Harness, s: number) => new Date(h.clock() + s * 1000).toISOString();
const prComments = (h: Harness, pr: number, event: string) => h.comments(pr).filter((c) => c.includes(`event=${event} -->`));
const eventKinds = (h: Harness, chainId: number) => chainEvents(h.db, chainId).map((e) => e.kind);
const executes = (h: Harness, chainId: number) => h.jobs(chainId).filter((j) => j.type === 'execute');

const failure = (name: string, over: Partial<CheckInfo> = {}): CheckInfo => ({
  name, status: 'completed', conclusion: 'failure', detailsUrl: 'https://github.com/o/r/actions/runs/900/job/1', runId: 900, ...over,
});
const passed = (name: string): CheckInfo => ({ name, status: 'completed', conclusion: 'success' });

/** A supervised chain driven to `awaiting_merge`; every execute writes its own file. */
async function awaitingMerge(h: Harness) {
  const { chain } = await h.submit(N);
  h.scriptExecute((input, call) => {
    h.write(input, `rev-${call}.txt`, `revision ${call}\n`);
    return ok(`revision ${call} done`);
  });
  h.scriptReview(Array.from({ length: 8 }, () => ({ verdict: 'approve' as const, feedback: 'lgtm' })));
  await h.runUntilIdle();
  expect(h.chain(chain.id)).toMatchObject({ status: 'waiting', state: { phase: 'awaiting_merge' } });
  return { chain, pr: h.pr(BRANCH)!.number, head: h.remoteHead(BRANCH)! };
}

describe('revising the pull request when required checks fail', () => {
  it('starts one round, gives the agent the failure, reviews the fix and comments once', async () => {
    const h = harness();
    const { chain, pr, head } = await awaitingMerge(h);
    h.host.setChecks(head, [failure('check (node 22)'), failure('check (node 24)'), passed('lint')]);
    h.host.setFailedLog(900, 'FAIL test/status.test.ts\nexpected 1 to be 2');

    expect(await h.maintain()).toEqual([]);
    expect(h.chain(chain.id)).toMatchObject({
      status: 'active',
      state: { phase: 'executing', attempt: 2, attemptBase: 1, ciRounds: 1, ciActive: true, lastPushedSha: head },
    });
    // The same failure does not start a second round on the next pass.
    await h.maintain();
    expect(executes(h, chain.id)).toHaveLength(2);

    await h.runOne();
    expect(h.pr(BRANCH)!.labels).not.toContain(READY);
    expect(h.issueLabels(N)).toContain(IN_PROGRESS);
    const input = h.callsOf('execute').at(-1)!;
    expect(input.feedback).toContain('check (node 22)');
    expect(input.feedback).toContain('check (node 24)');
    expect(input.feedback).toContain('expected 1 to be 2');
    expect(input.feedback).not.toContain('lint');

    await h.runUntilIdle();
    const newHead = h.remoteHead(BRANCH)!;
    expect(newHead).not.toBe(head);
    expect(h.chain(chain.id)).toMatchObject({ status: 'waiting', state: { phase: 'awaiting_merge', ciRounds: 1, lastPushedSha: newHead } });
    expect(h.chain(chain.id).state.ciActive).toBeUndefined();
    expect(h.pr(BRANCH)!.labels).toEqual([READY]);
    expect(h.issueLabels(N)).not.toContain(IN_PROGRESS);
    expect(h.callsOf('review')).toHaveLength(2);
    const comments = prComments(h, pr, 'ci-round-1');
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain(`Fixed failing checks in ${newHead.slice(0, 7)}`);
    expect(eventKinds(h, chain.id)).toEqual(expect.arrayContaining(['ci.failed', 'ci.fixed']));
    expect(chainEvents(h.db, chain.id).find((e) => e.kind === 'ci.failed')!.detail).toMatchObject({ checks: ['check (node 22)', 'check (node 24)'], round: 1 });
    expect(chainEvents(h.db, chain.id).find((e) => e.kind === 'ci.fixed')!.detail).toMatchObject({ round: 1 });

    // Checks on the new head are not read as failing: nothing more starts.
    h.host.setChecks(newHead, [{ name: 'check (node 22)', status: 'in_progress', conclusion: null }]);
    await h.maintain();
    expect(executes(h, chain.id)).toHaveLength(2);
  });

  it('still works when the log cannot be read', async () => {
    const h = harness();
    const { chain, head } = await awaitingMerge(h);
    h.host.setChecks(head, [failure('check (node 22)')]);
    await h.maintain();
    await h.runOne();
    expect(h.callsOf('execute').at(-1)!.feedback).toContain('check (node 22)');
    expect(h.chain(chain.id).state.ciRounds).toBe(1);
  });

  it.each([
    ['pending', [{ name: 'a', status: 'in_progress', conclusion: null } as CheckInfo]],
    ['passing', [passed('a')]],
    ['none', []],
  ])('starts nothing for %s checks', async (_name, checks) => {
    const h = harness();
    const { chain, head } = await awaitingMerge(h);
    h.host.setChecks(head, checks);
    await h.maintain();
    expect(executes(h, chain.id)).toHaveLength(1);
    expect(h.chain(chain.id)).toMatchObject({ status: 'waiting', state: { phase: 'awaiting_merge' } });
  });

  it('ignores failing checks of another commit and never reads checks for a head the chain did not push', async () => {
    const h = harness();
    const { chain, head } = await awaitingMerge(h);
    h.host.setChecks('0000000aaaa', [failure('old')]);
    await h.maintain();
    expect(executes(h, chain.id)).toHaveLength(1);
    expect(h.host.calls.filter((c) => c.method === 'getChecks').map((c) => c.args[1])).toEqual([head]);

    // A person pushed: the head is not the commit the chain pushed.
    h.host.headShaOf = () => '1111111bbbb';
    h.host.setChecks('1111111bbbb', [failure('theirs')]);
    h.host.calls.length = 0;
    await h.maintain();
    expect(h.host.calls.filter((c) => c.method === 'getChecks')).toEqual([]);
    expect(executes(h, chain.id)).toHaveLength(1);
  });

  it('a failure that disappears (a re-run passed) starts nothing', async () => {
    const h = harness();
    const { chain, head } = await awaitingMerge(h);
    h.host.setChecks(head, [failure('check (node 22)')]);
    h.host.setChecks(head, [passed('check (node 22)')]);
    await h.maintain();
    expect(executes(h, chain.id)).toHaveLength(1);
  });

  it('a transient getChecks failure leaves the chain as it is; the next pass retries', async () => {
    const h = harness();
    const { chain, head } = await awaitingMerge(h);
    h.host.setChecks(head, [failure('check (node 22)')]);
    h.host.failNext('getChecks', new GitHostError('boom', 502));
    expect(await h.maintain()).toEqual([]);
    expect(h.chain(chain.id)).toMatchObject({ status: 'waiting', state: { phase: 'awaiting_merge' } });
    expect(executes(h, chain.id)).toHaveLength(1);
    await h.maintain();
    expect(h.chain(chain.id)).toMatchObject({ status: 'active', state: { ciRounds: 1 } });
  });

  it('stops at maxCiRounds: needs_human, still waiting, one comment, own budget', async () => {
    const h = harness({ maxCiRounds: 1, maxHumanRounds: 1, maxConflictRounds: 1 });
    const { chain, pr, head } = await awaitingMerge(h);
    h.host.setChecks(head, [failure('check (node 22)')]);
    await h.maintain();
    await h.runUntilIdle();
    const second = h.remoteHead(BRANCH)!;
    expect(h.chain(chain.id)).toMatchObject({ status: 'waiting', state: { phase: 'awaiting_merge', ciRounds: 1 } });
    expect(h.chain(chain.id).state.humanRounds ?? 0).toBe(0);
    expect(h.chain(chain.id).state.conflictRounds ?? 0).toBe(0);

    h.host.setChecks(second, [failure('check (node 24)')]);
    await h.maintain();
    expect(h.chain(chain.id)).toMatchObject({ status: 'waiting', state: { phase: 'needs_human', ciRounds: 1 } });
    await h.maintain();
    await h.maintain();
    expect(executes(h, chain.id)).toHaveLength(2);
    const limit = prComments(h, pr, 'ci-round-limit');
    expect(limit).toHaveLength(1);
    expect(limit[0]).toContain('check (node 24)');
    expect(limit[0]).toContain('maxCiRounds');
    expect(h.issueLabels(N)).toContain(NEEDS_HUMAN);
    const gaveUp = chainEvents(h.db, chain.id).filter((e) => e.kind === 'ci.gave_up');
    expect(gaveUp).toHaveLength(1);
    expect(gaveUp[0]!.detail).toMatchObject({ reason: expect.stringContaining('exhausted') });
  });

  it('CI rounds leave the reviewer attempts untouched', async () => {
    const h = harness();
    const { chain, head } = await awaitingMerge(h);
    h.host.setChecks(head, [failure('check (node 22)')]);
    await h.maintain();
    // attemptBase moves with the round, so the reviewer keeps its whole budget.
    const s = h.chain(chain.id).state;
    expect(s.attempt - (s.attemptBase ?? 0)).toBe(1);
  });

  it('orders a conflict round first, then CI, then human feedback', async () => {
    const h = harness();
    const { chain, pr, head } = await awaitingMerge(h);
    h.remote.commit('main', 'other.txt', 'main moved\n');
    h.host.setMergeable(pr, 'conflicting');
    h.host.setChecks(head, [failure('check (node 22)')]);
    h.host.addConversationComment(pr, { createdAt: at(h, 60), body: 'please rename the file' });

    await h.maintain();
    expect(h.chain(chain.id).state).toMatchObject({ conflictRounds: 1, conflictActive: true });
    expect(h.chain(chain.id).state.ciRounds ?? 0).toBe(0);
    h.host.setMergeable(pr, 'mergeable');
    await h.runUntilIdle();
    expect(h.chain(chain.id)).toMatchObject({ status: 'waiting', state: { phase: 'awaiting_merge' } });

    // CI of the conflict resolution's head fails: CI before the feedback that is still waiting.
    h.host.setChecks(h.remoteHead(BRANCH)!, [failure('check (node 24)')]);
    await h.maintain();
    expect(h.chain(chain.id).state).toMatchObject({ ciRounds: 1, ciActive: true });
    expect(h.chain(chain.id).state.humanRounds ?? 0).toBe(0);
    await h.runUntilIdle();

    // The CI fix is clean: the feedback comes last.
    await h.maintain();
    expect(h.chain(chain.id).state).toMatchObject({ humanRounds: 1, ciRounds: 1, conflictRounds: 1 });
    expect(h.chain(chain.id).state.ciActive).toBeFalsy();
  });
});
