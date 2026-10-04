import { afterEach, describe, expect, it } from 'vitest';
import { GitHostError } from '../../src/engines/software/github.js';
import { chainEvents } from '../../src/kernel/events.js';
import { makeHarness, ok, type Harness } from '../support/harness.js';

const N = 7;
const BRANCH = `factory/issue-${N}`;

const harnesses: Harness[] = [];
const harness = (): Harness => {
  const h = makeHarness();
  harnesses.push(h);
  return h;
};
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

const at = (h: Harness, s: number) => new Date(h.clock() + s * 1000).toISOString();
type Responses = Array<{ id: string; action: 'changed' | 'explained' | 'declined'; reply: string }>;

/** The chain waiting with an open pull request after the first (unrevised) attempt. */
async function awaitingMerge(h: Harness) {
  const { chain } = await h.submit(N);
  h.scriptExecute((input, call) => {
    h.write(input, `rev-${call}.txt`, `revision ${call}\n`);
    return ok(`revision ${call} done`);
  });
  h.scriptReview(Array.from({ length: 4 }, () => ({ verdict: 'approve' as const, feedback: 'lgtm' })));
  await h.runUntilIdle();
  return { chain, pr: h.pr(BRANCH)!.number };
}

/** The next execute run (the feedback round) writes a file (or not) and answers with `responses`. */
function scriptRound(h: Harness, responses: unknown, opts: { change: boolean } = { change: true }) {
  h.scriptExecute((input) => {
    if (opts.change) h.write(input, 'round-change.txt', 'changed for the feedback\n');
    return { ...ok('round done'), ...(responses === undefined ? {} : { feedbackResponses: responses }) };
  });
}

const inlineBodies = async (h: Harness, pr: number) => (await h.host.listPrFeedback('o/r', pr)).reviewComments.filter((c) => c.author === 'factory').map((c) => c.body);
const kinds = (h: Harness, chainId: number, kind: string) => chainEvents(h.db, chainId).filter((e) => e.kind === kind);

describe('answering review comments', () => {
  it('replies to an inline comment answered with a code change, names the commit and resolves the thread', async () => {
    const h = harness();
    const { chain, pr } = await awaitingMerge(h);
    h.advance(10_000);
    const id = h.host.addReviewComment(pr, { createdAt: at(h, 5), body: 'Please say hello instead' });
    scriptRound(h, [{ id: `comment ${id}`, action: 'changed', reply: 'Now says hello in round-change.txt.' }] satisfies Responses);
    await h.maintain();
    await h.runUntilIdle();

    expect(h.callsOf('execute')[1]!.feedback).toContain(`(comment ${id})`);
    expect(h.chain(chain.id)).toMatchObject({ status: 'waiting', state: { phase: 'awaiting_merge', pendingReplies: [] } });
    const sha = h.remoteHead(BRANCH)!.slice(0, 7);
    const replies = await inlineBodies(h, pr);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain('Now says hello in round-change.txt.');
    expect(replies[0]).toContain(`(commit ${sha})`);
    expect(replies[0]).toContain(`<!-- factory:reply comment=${id} -->`);
    expect(h.host.isThreadResolved(h.host.threadOf(pr, id)!)).toBe(true);
    const summary = h.comments(pr).filter((c) => c.includes('event=human-round-1 -->'));
    expect(summary).toHaveLength(1);
    expect(summary[0]).toContain('1 changed, 0 explained, 0 declined');
    expect(summary[0]).toContain(h.remoteHead(BRANCH)!);
    expect(kinds(h, chain.id, 'feedback.replied').map((e) => e.detail)).toEqual([{ id: `comment ${id}`, action: 'changed' }]);
    expect(kinds(h, chain.id, 'feedback.resolved').map((e) => e.detail)).toEqual([{ thread: h.host.threadOf(pr, id) }]);

    // A second and third maintenance pass post nothing new and start no round.
    const before = [h.comments(pr).length, (await inlineBodies(h, pr)).length, h.jobs(chain.id).length];
    await h.maintain();
    await h.maintain();
    expect([h.comments(pr).length, (await inlineBodies(h, pr)).length, h.jobs(chain.id).length]).toEqual(before);
  });

  it('answers a question with an explanation: no code change, thread resolved, back to awaiting_merge', async () => {
    const h = harness();
    const { chain, pr } = await awaitingMerge(h);
    const log = h.remoteLog(BRANCH);
    const id = h.host.addReviewComment(pr, { createdAt: at(h, 60), body: 'Why a text file?' });
    scriptRound(h, [{ id: `comment ${id}`, action: 'explained', reply: 'Because the task only needs a marker file.' }], { change: false });
    await h.maintain();
    await h.runUntilIdle();

    expect(h.remoteLog(BRANCH)).toEqual(log);
    expect(h.jobs(chain.id).filter((j) => j.type === 'review')).toHaveLength(1);
    expect(h.chain(chain.id)).toMatchObject({ status: 'waiting', state: { phase: 'awaiting_merge' } });
    expect(h.pr(BRANCH)!.labels).toEqual(['factory:ready-for-merge']);
    const replies = await inlineBodies(h, pr);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain('Because the task only needs a marker file.');
    expect(replies[0]).not.toContain('(commit');
    expect(h.host.isThreadResolved(h.host.threadOf(pr, id)!)).toBe(true);
    const summary = h.comments(pr).filter((c) => c.includes('event=human-round-1 -->'));
    expect(summary).toHaveLength(1);
    expect(summary[0]).toContain('0 changed, 1 explained, 0 declined');
    expect(h.comments(pr).some((c) => c.includes('unchanged'))).toBe(false);
  });

  it('leaves the thread of a declined comment open', async () => {
    const h = harness();
    const { pr } = await awaitingMerge(h);
    const id = h.host.addReviewComment(pr, { createdAt: at(h, 60), body: 'Rewrite it in Rust' });
    scriptRound(h, [{ id: `comment ${id}`, action: 'declined', reply: 'The repository is TypeScript.' }], { change: false });
    await h.maintain();
    await h.runUntilIdle();
    expect(await inlineBodies(h, pr)).toHaveLength(1);
    expect(h.host.isThreadResolved(h.host.threadOf(pr, id)!)).toBe(false);
    expect(h.comments(pr).find((c) => c.includes('event=human-round-1 -->'))).toContain('0 changed, 0 explained, 1 declined');
  });

  it('replies to a conversation comment with a quoting comment and resolves nothing', async () => {
    const h = harness();
    const { chain, pr } = await awaitingMerge(h);
    const id = h.host.addConversationComment(pr, { createdAt: at(h, 60), body: 'Is this safe?\nI worry about @team.' });
    scriptRound(h, [{ id: `comment ${id}`, action: 'explained', reply: 'Yes, ping @someone is not needed.' }], { change: false });
    await h.maintain();
    await h.runUntilIdle();
    const reply = h.comments(pr).find((c) => c.includes(`<!-- factory:reply comment=${id} -->`))!;
    expect(reply).toContain('> Is this safe?');
    expect(reply).not.toContain('I worry');
    expect(reply).toContain('Yes, ping @​someone');
    expect(kinds(h, chain.id, 'feedback.resolved')).toHaveLength(0);
    // The conversation reply is never fed back as feedback, and replying twice does not happen.
    await h.maintain();
    await h.maintain();
    expect(h.comments(pr).filter((c) => c.includes(`<!-- factory:reply comment=${id} -->`))).toHaveLength(1);
    expect(h.jobs(chain.id).filter((j) => j.type === 'execute')).toHaveLength(2);
  });

  it('answers a review body with a quoting comment', async () => {
    const h = harness();
    const { pr } = await awaitingMerge(h);
    const reviewId = h.host.addReview(pr, { state: 'CHANGES_REQUESTED', submittedAt: at(h, 60), body: 'Needs work overall\nsecond line' });
    scriptRound(h, [{ id: `review ${reviewId}`, action: 'changed', reply: 'Reworked.' }]);
    await h.maintain();
    await h.runUntilIdle();
    const reply = h.comments(pr).find((c) => c.includes(`<!-- factory:reply review=${reviewId} -->`))!;
    expect(reply).toContain('> Needs work overall');
    expect(reply).toContain('Reworked. (commit ');
  });

  it('names an item without a response once, leaves its thread open and answers the others', async () => {
    const h = harness();
    const { chain, pr } = await awaitingMerge(h);
    const a = h.host.addReviewComment(pr, { createdAt: at(h, 60), body: 'one' });
    const b = h.host.addReviewComment(pr, { createdAt: at(h, 61), body: 'two' });
    scriptRound(h, [
      { id: `comment ${a}`, action: 'explained', reply: 'ok' },
      { id: 'comment 4242', action: 'changed', reply: 'not in the round' },
      { id: `comment ${a}`, action: 'declined', reply: 'duplicate, dropped' },
    ], { change: false });
    await h.maintain();
    await h.runUntilIdle();
    await h.maintain();
    await h.maintain();
    const replies = await inlineBodies(h, pr);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain('ok');
    expect(replies.join()).not.toContain('not in the round');
    expect(replies.join()).not.toContain('duplicate');
    expect(h.host.isThreadResolved(h.host.threadOf(pr, a)!)).toBe(true);
    expect(h.host.isThreadResolved(h.host.threadOf(pr, b)!)).toBe(false);
    const named = h.comments(pr).filter((c) => c.includes('no answer for'));
    expect(named).toHaveLength(1);
    expect(named[0]).toContain(`comment ${b}`);
    expect(named[0]).not.toContain(`comment ${a}`);
    expect(h.chain(chain.id).state.phase).toBe('awaiting_merge');
  });

  it('treats malformed responses as none: the run succeeds and every item is named', async () => {
    const h = harness();
    const { chain, pr } = await awaitingMerge(h);
    const id = h.host.addReviewComment(pr, { createdAt: at(h, 60), body: 'one' });
    scriptRound(h, 'not a list', { change: false });
    await h.maintain();
    await h.runUntilIdle();
    expect(h.chain(chain.id)).toMatchObject({ status: 'waiting', state: { phase: 'awaiting_merge' } });
    expect(await inlineBodies(h, pr)).toHaveLength(0);
    expect(h.comments(pr).filter((c) => c.includes(`no answer for: comment ${id}`))).toHaveLength(1);
  });

  it('reports a reply failure without failing the run, then retries it on the next maintenance pass', async () => {
    const h = harness();
    const { chain, pr } = await awaitingMerge(h);
    const id = h.host.addReviewComment(pr, { createdAt: at(h, 60), body: 'Please change it' });
    scriptRound(h, [{ id: `comment ${id}`, action: 'changed', reply: 'Changed.' }]);
    await h.maintain();
    h.host.failNext('replyToReviewComment', new GitHostError('Validation Failed', 422));
    await h.runUntilIdle();

    expect(h.deadLetters()).toEqual([]);
    expect(h.chain(chain.id)).toMatchObject({ status: 'waiting', state: { phase: 'awaiting_merge' } });
    expect(h.remoteFiles(BRANCH)).toContain('round-change.txt');
    expect(h.engineErrors.join()).toContain('Validation Failed');
    expect(kinds(h, chain.id, 'feedback.reply_failed')).toHaveLength(1);
    expect(await inlineBodies(h, pr)).toHaveLength(0);
    expect(h.chain(chain.id).state.pendingReplies).toHaveLength(1);
    const sha = h.chain(chain.id).state.pendingReplies![0]!.sha;
    expect(sha).toBe(h.remoteHead(BRANCH)!.slice(0, 7));

    await h.maintain();
    const replies = await inlineBodies(h, pr);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain(`(commit ${sha})`);
    expect(h.host.isThreadResolved(h.host.threadOf(pr, id)!)).toBe(true);
    expect(h.chain(chain.id).state.pendingReplies).toEqual([]);
    await h.maintain();
    expect(await inlineBodies(h, pr)).toHaveLength(1);
  });

  it('retries a thread that could not be resolved without replying twice', async () => {
    const h = harness();
    const { chain, pr } = await awaitingMerge(h);
    const id = h.host.addReviewComment(pr, { createdAt: at(h, 60), body: 'Why?' });
    scriptRound(h, [{ id: `comment ${id}`, action: 'explained', reply: 'Because.' }], { change: false });
    await h.maintain();
    h.host.failNext('resolveReviewThread', new GitHostError('Forbidden', 403));
    await h.runUntilIdle();
    expect(await inlineBodies(h, pr)).toHaveLength(1);
    expect(h.host.isThreadResolved(h.host.threadOf(pr, id)!)).toBe(false);
    await h.maintain();
    expect(await inlineBodies(h, pr)).toHaveLength(1);
    expect(h.host.isThreadResolved(h.host.threadOf(pr, id)!)).toBe(true);
    expect(kinds(h, chain.id, 'feedback.replied')).toHaveLength(1);
  });

  it('retries transient GraphQL errors when resolving', async () => {
    const h = harness();
    const { pr } = await awaitingMerge(h);
    const id = h.host.addReviewComment(pr, { createdAt: at(h, 60), body: 'Why?' });
    scriptRound(h, [{ id: `comment ${id}`, action: 'explained', reply: 'Because.' }], { change: false });
    await h.maintain();
    h.host.failNext('resolveReviewThread', new GitHostError('Bad Gateway', 502));
    await h.runUntilIdle();
    expect(h.host.isThreadResolved(h.host.threadOf(pr, id)!)).toBe(true);
    expect(h.engineErrors).toEqual([]);
  });

  it('redacts secrets from replies', async () => {
    const h = harness();
    const { pr } = await awaitingMerge(h);
    const id = h.host.addReviewComment(pr, { createdAt: at(h, 60), body: 'What key?' });
    const token = 'gh' + 'p_' + 'a'.repeat(36);
    scriptRound(h, [{ id: `comment ${id}`, action: 'explained', reply: `The key is ${token}` }], { change: false });
    await h.maintain();
    await h.runUntilIdle();
    const replies = await inlineBodies(h, pr);
    expect(replies).toHaveLength(1);
    expect(replies[0]).not.toContain(token);
  });
});

describe('resolved threads are not fed back', () => {
  it('ignores a thread a person resolved', async () => {
    const h = harness();
    const { chain, pr } = await awaitingMerge(h);
    const id = h.host.addReviewComment(pr, { createdAt: at(h, 60), body: 'nit' });
    h.host.resolveThread(h.host.threadOf(pr, id)!);
    await h.maintain();
    expect(h.jobs(chain.id).filter((j) => j.type === 'execute')).toHaveLength(1);
  });

  it('feeds back a newer comment on a thread the factory answered and resolved', async () => {
    const h = harness();
    const { chain, pr } = await awaitingMerge(h);
    h.advance(10_000);
    const id = h.host.addReviewComment(pr, { createdAt: at(h, 5), body: 'Why a text file?' });
    scriptRound(h, [{ id: `comment ${id}`, action: 'explained', reply: 'Because.' }], { change: false });
    await h.maintain();
    await h.runUntilIdle();
    const thread = h.host.threadOf(pr, id)!;
    expect(h.host.isThreadResolved(thread)).toBe(true);
    await h.maintain();
    expect(h.jobs(chain.id).filter((j) => j.type === 'execute')).toHaveLength(2);

    h.advance(60_000);
    const again = h.host.addReviewComment(pr, { createdAt: at(h, 1), body: 'That is not an answer', threadId: thread });
    scriptRound(h, [{ id: `comment ${again}`, action: 'changed', reply: 'Added more.' }]);
    await h.maintain();
    expect(h.jobs(chain.id).filter((j) => j.type === 'execute')).toHaveLength(3);
    expect(h.chain(chain.id).state.humanRounds).toBe(2);
  });
});
