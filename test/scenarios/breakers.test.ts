import { afterEach, describe, expect, it } from 'vitest';
import { chainEvents } from '../../src/kernel/events.js';
import { makeHarness, ok, type Harness, type HarnessOptions } from '../support/harness.js';

const N = 7;
const BRANCH = `factory/issue-${N}`;
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
const kinds = (h: Harness, chainId: number) => chainEvents(h.db, chainId).map((e) => e.kind);
const asks = (h: Harness, n: number) => h.comments(n).filter((c) => c.includes('event=ask id='));
const executes = (h: Harness, chainId: number) => h.jobs(chainId).filter((j) => j.type === 'execute');
const approve = () => Array.from({ length: 60 }, () => ({ verdict: 'approve' as const, feedback: 'lgtm' }));

/** A chain waiting for a merge; its README.md differs from main's once main moves, so rounds conflict. */
async function awaitingMerge(h: Harness) {
  const { chain } = await h.submit(N);
  h.scriptExecute((input) => (h.write(input, 'README.md', 'branch version\n'), ok('first change')));
  h.scriptReview(approve());
  await h.runUntilIdle();
  expect(h.chain(chain.id)).toMatchObject({ status: 'waiting', state: { phase: 'awaiting_merge' } });
  return { chain, pr: h.pr(BRANCH)!.number };
}

/** The base branch moves (a new base head) and the pull request conflicts again. */
let moves = 0;
function baseMoves(h: Harness, pr: number): void {
  h.remote.commit('main', 'README.md', `main version ${++moves}\n`);
  h.host.setMergeable(pr, 'conflicting');
}

/** Scripts the agent: it resolves the conflict, or (`fails`) leaves the markers in, which the push refuses. */
function agent(h: Harness, behaviour: () => 'resolve' | 'fail'): void {
  h.scriptExecute((input, call) => {
    if (behaviour() === 'resolve') h.write(input, 'README.md', `resolved ${call}\n`);
    return ok('round');
  });
}

describe('circuit breakers', () => {
  it('ten successful conflict rounds in a row never open the breaker', async () => {
    const h = harness();
    const { chain, pr } = await awaitingMerge(h);
    agent(h, () => 'resolve');
    for (let i = 0; i < 10; i++) {
      baseMoves(h, pr);
      await h.maintain();
      await h.runUntilIdle();
      expect(h.chain(chain.id)).toMatchObject({ status: 'waiting', state: { phase: 'awaiting_merge' } });
    }
    expect(executes(h, chain.id)).toHaveLength(11);
    expect(h.chain(chain.id).state.breakers?.conflict).toEqual({ consecutiveFailures: 0, opens: 0 });
    expect(kinds(h, chain.id)).not.toContain('breaker.opened');
    expect(asks(h, pr)).toHaveLength(0);
    expect(h.issueLabels(N)).not.toContain(NEEDS_HUMAN);
  });

  it('three consecutive failed rounds open the breaker and the chain waits without comments; a successful trial after the cool-down closes it', async () => {
    const h = harness();
    const { chain, pr } = await awaitingMerge(h);
    let mode: 'resolve' | 'fail' = 'fail';
    agent(h, () => mode);
    baseMoves(h, pr);
    for (let i = 0; i < 3; i++) {
      await h.maintain();
      await h.runUntilIdle();
    }
    expect(executes(h, chain.id)).toHaveLength(4);
    expect(h.chain(chain.id).state.breakers?.conflict).toMatchObject({ consecutiveFailures: 3, opens: 1 });
    expect(kinds(h, chain.id)).toContain('breaker.opened');
    const comments = h.comments(pr).length;

    // Open: the chain keeps waiting and posts nothing, however often it is looked at.
    for (let i = 0; i < 4; i++) await h.maintain();
    expect(executes(h, chain.id)).toHaveLength(4);
    expect(h.comments(pr)).toHaveLength(comments);
    expect(h.chain(chain.id)).toMatchObject({ status: 'waiting' });

    // Half-open: exactly one trial round, which succeeds.
    h.advance(10 * 60_000 + 1);
    mode = 'resolve';
    await h.maintain();
    expect(kinds(h, chain.id)).toContain('breaker.half_open');
    expect(executes(h, chain.id)).toHaveLength(5);
    await h.runUntilIdle();
    expect(h.chain(chain.id).state.breakers?.conflict).toEqual({ consecutiveFailures: 0, opens: 0 });
    expect(kinds(h, chain.id)).toContain('breaker.closed');
    expect(asks(h, pr)).toHaveLength(0);
  });

  it('a new base head after a success starts a new round that does not count against the breaker', async () => {
    const h = harness();
    const { chain, pr } = await awaitingMerge(h);
    let mode: 'resolve' | 'fail' = 'fail';
    agent(h, () => mode);
    baseMoves(h, pr);
    await h.maintain();
    await h.runUntilIdle();
    await h.maintain();
    await h.runUntilIdle();
    expect(h.chain(chain.id).state.breakers?.conflict).toMatchObject({ consecutiveFailures: 2 });
    mode = 'resolve';
    await h.maintain();
    await h.runUntilIdle();
    expect(h.chain(chain.id).state.breakers?.conflict).toEqual({ consecutiveFailures: 0, opens: 0 });

    baseMoves(h, pr);
    await h.maintain();
    expect(h.chain(chain.id)).toMatchObject({ status: 'active', state: { conflictActive: true } });
    await h.runUntilIdle();
    expect(h.chain(chain.id).state.breakers?.conflict).toEqual({ consecutiveFailures: 0, opens: 0 });
  });

  it('a person\'s ten feedback rounds do not open anything', async () => {
    const h = harness();
    const { chain, pr } = await awaitingMerge(h);
    h.scriptExecute((input, call) => (h.write(input, `rev-${call}.txt`, `v${call}\n`), ok('done')));
    for (let i = 1; i <= 10; i++) {
      h.advance(60_000);
      h.host.addConversationComment(pr, { createdAt: at(h, 1), body: `change number ${i}` });
      await h.maintain();
      await h.runUntilIdle();
      expect(h.chain(chain.id)).toMatchObject({ status: 'waiting', state: { phase: 'awaiting_merge' } });
    }
    expect(executes(h, chain.id)).toHaveLength(11);
    const b = h.chain(chain.id).state.breakers ?? {};
    for (const s of Object.values(b)) expect(s).toEqual({ consecutiveFailures: 0, opens: 0 });
    expect(kinds(h, chain.id)).not.toContain('breaker.opened');
    expect(asks(h, pr)).toHaveLength(0);
  });
});

describe('what counts as a failure', () => {
  it('an agent result with status error, in a round of a class is a failure', async () => {
    const h = harness();
    const { chain, pr } = await awaitingMerge(h);
    h.scriptExecute(() => ({ status: 'error', summary: 'the agent crashed' }));
    baseMoves(h, pr);
    await h.maintain();
    await h.runUntilIdle();
    expect(h.deadLetters()).toEqual([]);
    expect(h.chain(chain.id).state.breakers?.conflict).toMatchObject({ consecutiveFailures: 1 });
    expect(h.chain(chain.id).state.breakers?.human).toBeUndefined();
  });

  it('an invalid result in a round of a class is a failure', async () => {
    const h = harness();
    const { chain, pr } = await awaitingMerge(h);
    h.scriptExecute(() => ({ status: 'ok', summary: 's', ask: { question: '' } }));
    baseMoves(h, pr);
    await h.maintain();
    await h.runUntilIdle();
    expect(h.deadLetters()).toEqual([]);
    expect(h.chain(chain.id).state.breakers?.conflict).toMatchObject({ consecutiveFailures: 1 });
  });

  it('a transient infrastructure failure is not counted (the kernel retries it separately)', async () => {
    const h = harness();
    const { chain, pr } = await awaitingMerge(h);
    const engine = h.engine;
    const view = { ...h.chain(chain.id), state: { ...h.chain(chain.id).state, phase: 'executing' as const, conflictActive: true } };
    const job = h.jobs(chain.id)[0]!;
    const asJob = { ...job, type: 'execute' } as Parameters<NonNullable<typeof engine.absorbFailure>>[1];
    expect(await engine.absorbFailure!(view, asJob, 'runner_error', 'transient_retries_exhausted after 8 retries: ECONNRESET')).toBeNull();
    expect(await engine.absorbFailure!(view, asJob, 'timeout', 'timed out')).toBeNull();
    // Nothing is absorbed for a first attempt or a round that is not one of a class.
    expect(await engine.absorbFailure!({ ...view, state: { ...view.state, conflictActive: false } }, asJob, 'runner_error', 'boom')).toBeNull();
    expect(await engine.absorbFailure!(view, asJob, 'runner_error', 'boom')).toMatchObject({ breakers: { conflict: { consecutiveFailures: 1 } } });
    expect(pr).toBeGreaterThan(0);
  });
});

describe('asks', () => {
  it('maxOpens raises exactly one ask; a later human comment resumes the chain as a feedback round and resets the breakers', async () => {
    const h = harness({ breakers: { conflict: { failureThreshold: 1, cooldownMs: 1000, maxOpens: 2 } } });
    const { chain, pr } = await awaitingMerge(h);
    let mode: 'resolve' | 'fail' = 'fail';
    agent(h, () => mode);
    baseMoves(h, pr);
    await h.maintain();
    await h.runUntilIdle(); // opens the breaker (1)
    h.advance(1001);
    await h.maintain();
    await h.runUntilIdle(); // the trial fails: opens it for the second time

    expect(h.chain(chain.id)).toMatchObject({ status: 'waiting', state: { phase: 'needs_input', ask: { class: 'conflict' } } });
    expect(asks(h, pr)).toHaveLength(1);
    expect(asks(h, pr)[0]).toContain('What was tried');
    expect(asks(h, pr)[0]).toContain('`conflict`: 2 consecutive failure(s), the breaker opened 2 time(s)');
    expect(h.issueLabels(N)).toContain(NEEDS_HUMAN);
    expect(kinds(h, chain.id)).toEqual(expect.arrayContaining(['breaker.opened', 'ask.raised']));
    const runs = executes(h, chain.id).length;
    h.advance(3 * 3_600_000);
    for (let i = 0; i < 3; i++) await h.maintain();
    expect(executes(h, chain.id)).toHaveLength(runs);
    expect(asks(h, pr)).toHaveLength(1);

    // A person answers.
    mode = 'resolve';
    h.host.addConversationComment(pr, { createdAt: at(h, 30), body: 'Keep the main version.' });
    await h.maintain();
    expect(h.chain(chain.id)).toMatchObject({ status: 'active', state: { phase: 'executing', humanActive: true, breakers: {} } });
    expect(h.chain(chain.id).state.ask).toBeUndefined();
    expect(h.issueLabels(N)).not.toContain(NEEDS_HUMAN);
    expect(kinds(h, chain.id)).toContain('ask.answered');
    await h.runOne();
    const feedback = h.callsOf('execute').at(-1)!.feedback ?? '';
    expect(feedback).toContain('The factory asked:');
    expect(feedback).toContain('Keep the main version.');
    await h.runUntilIdle();
    expect(h.chain(chain.id)).toMatchObject({ status: 'waiting', state: { phase: 'awaiting_merge' } });
    expect(asks(h, pr)).toHaveLength(1);
  });

  it('an ask returned by the agent in a round posts one comment, pushes nothing and touches no breaker', async () => {
    const h = harness();
    const { chain, pr } = await awaitingMerge(h);
    const head = h.remoteHead(BRANCH);
    baseMoves(h, pr);
    h.scriptExecute(() => ({ ...ok('two valid resolutions'), ask: { question: 'Keep which version of README.md?', options: ['mine', 'main'] } }));
    await h.maintain();
    await h.runUntilIdle();

    expect(h.chain(chain.id)).toMatchObject({ status: 'waiting', state: { phase: 'needs_input', ask: { question: 'Keep which version of README.md?' } } });
    expect(h.chain(chain.id).state.breakers?.conflict ?? { consecutiveFailures: 0 }).toMatchObject({ consecutiveFailures: 0 });
    expect(h.remoteHead(BRANCH)).toBe(head);
    expect(h.deadLetters()).toEqual([]);
    expect(asks(h, pr)).toHaveLength(1);
    expect(asks(h, pr)[0]).toContain('Keep which version of README.md?');
    expect(asks(h, pr)[0]).toContain('1. mine');
    expect(h.issueLabels(N)).toContain(NEEDS_HUMAN);
    for (let i = 0; i < 3; i++) await h.maintain();
    expect(executes(h, chain.id)).toHaveLength(2);
    expect(asks(h, pr)).toHaveLength(1);
  });

  it('an ask returned by the first attempt is posted on the issue, with no pull request', async () => {
    const h = harness();
    const { chain } = await h.submit(N);
    h.scriptExecute(() => ({ ...ok('cannot decide'), ask: { question: 'REST or GraphQL?' } }));
    await h.runUntilIdle();
    expect(h.chain(chain.id)).toMatchObject({ status: 'waiting', state: { phase: 'needs_input' } });
    expect(asks(h, N)).toHaveLength(1);
    expect(h.pr(BRANCH)).toBeNull();
    expect(h.issueLabels(N)).toContain(NEEDS_HUMAN);
  });

  it('chainBudgetUsd exceeded raises one ask and stops automatic rounds', async () => {
    const h = harness({ chainBudgetUsd: 1 });
    const { chain } = await h.submit(N);
    h.scriptExecute((input) => ({ ...(h.write(input, 'README.md', 'branch version\n'), ok('first')), costUsd: 0.7 }));
    h.scriptReview(Array.from({ length: 10 }, () => ({ verdict: 'approve' as const, feedback: 'ok', costUsd: 0.5 })));
    await h.runUntilIdle();
    const pr = h.pr(BRANCH)!.number;
    baseMoves(h, pr);
    for (let i = 0; i < 3; i++) await h.maintain();

    expect(h.chain(chain.id)).toMatchObject({ status: 'waiting', state: { phase: 'needs_input', ask: { reason: 'chain budget exceeded' } } });
    expect(executes(h, chain.id)).toHaveLength(1);
    expect(asks(h, pr)).toHaveLength(1);
    expect(asks(h, pr)[0]).toContain('chainBudgetUsd');
  });
});
