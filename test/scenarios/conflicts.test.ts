import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { chainEvents } from '../../src/kernel/events.js';
import { makeHarness, ok, type Harness, type HarnessOptions } from '../support/harness.js';
import { GIT_TEST_ENV } from '../support/temp-repo.js';

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
const gitR = (h: Harness, args: string[]) =>
  execFileSync('git', args, { cwd: h.remote.path, env: GIT_TEST_ENV, encoding: 'utf8' }).trim();
const eventKinds = (h: Harness, chainId: number) => chainEvents(h.db, chainId).map((e) => e.kind);

/**
 * A supervised chain driven to `awaiting_merge`: its first execute changes `file` (README.md by default),
 * so a later change of `main` to the same file conflicts.
 */
async function awaitingMerge(h: Harness, file = 'README.md', content: string | Buffer = 'branch version\n') {
  const { chain } = await h.submit(N);
  h.scriptExecute((input, call) => {
    if (call === 0) {
      h.write(input, file, content as string);
      return ok('first change');
    }
    return ok('resolved');
  });
  h.scriptReview(Array.from({ length: 6 }, () => ({ verdict: 'approve' as const, feedback: 'lgtm' })));
  await h.runUntilIdle();
  expect(h.chain(chain.id)).toMatchObject({ status: 'waiting', state: { phase: 'awaiting_merge' } });
  return { chain, pr: h.pr(BRANCH)!.number };
}

describe('resolving merge conflicts on a waiting pull request', () => {
  it('starts one round, the agent resolves it, the merge commit is pushed as a fast-forward', async () => {
    const h = harness();
    const { chain, pr } = await awaitingMerge(h);
    const before = h.remoteHead(BRANCH)!;
    const mainHead = h.remote.commit('main', 'README.md', 'main version\n');
    h.host.setMergeable(pr, 'conflicting');
    h.scriptExecute((input) => {
      const readme = readFileSync(join(input.workspace.path, 'README.md'), 'utf8');
      expect(readme).toContain('<<<<<<< ');
      h.write(input, 'README.md', 'both versions\n');
      return ok('resolved');
    });

    expect(await h.maintain()).toEqual([]);
    expect(h.chain(chain.id)).toMatchObject({
      status: 'active',
      state: { phase: 'executing', attempt: 2, attemptBase: 1, conflictRounds: 1, conflictActive: true },
    });
    // A second pass does not start a second round for the same conflict.
    await h.maintain();
    expect(h.jobs(chain.id).filter((j) => j.type === 'execute')).toHaveLength(2);

    await h.runOne(); // the execute job
    expect(h.pr(BRANCH)!.labels).not.toContain(READY);
    expect(h.issueLabels(N)).toContain(IN_PROGRESS);
    const input = h.callsOf('execute').at(-1)!;
    expect(input.feedback).toContain('`main`');
    expect(input.feedback).toContain('- README.md');
    expect(input.feedback).toContain('keeping the intent of both sides');
    expect(input.feedback).toContain('Leave no conflict markers');
    expect(input.feedback).toContain('Do not reformat unrelated code');

    await h.runUntilIdle();
    expect(h.chain(chain.id)).toMatchObject({ status: 'waiting', state: { phase: 'awaiting_merge', conflictRounds: 1 } });
    expect(h.chain(chain.id).state.conflictActive).toBeUndefined();
    // The merge commit has both parents and the push was a fast-forward of the branch.
    const head = h.remoteHead(BRANCH)!;
    expect(gitR(h, ['rev-list', '--parents', '-n', '1', head]).split(' ').slice(1)).toEqual([before, mainHead]);
    expect(h.remoteFile(BRANCH, 'README.md')).toBe('both versions');
    expect(gitR(h, ['merge-base', '--is-ancestor', before, head])).toBe('');
    // Reviewed like any revision, then ready again with one comment.
    expect(h.callsOf('review').length).toBeGreaterThanOrEqual(2);
    expect(h.pr(BRANCH)!.labels).toEqual([READY]);
    expect(h.issueLabels(N)).not.toContain(IN_PROGRESS);
    const comments = prComments(h, pr, 'conflict-round-1');
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain(`Resolved conflicts with \`main\` in ${head.slice(0, 7)}`);
    expect(eventKinds(h, chain.id)).toEqual(expect.arrayContaining(['conflict.detected', 'conflict.resolved']));
    const detected = chainEvents(h.db, chain.id).find((e) => e.kind === 'conflict.detected')!;
    expect(detected.detail).toEqual({ baseBranch: 'main', round: 1, paths: 1 });
  });

  it('refuses leftover conflict markers and publishes nothing', async () => {
    const h = harness();
    const { chain, pr } = await awaitingMerge(h);
    const before = h.remoteHead(BRANCH);
    h.remote.commit('main', 'README.md', 'main version\n');
    h.host.setMergeable(pr, 'conflicting');
    h.scriptExecute(() => ok('forgot to resolve'));
    await h.maintain();
    await h.runUntilIdle();

    expect(h.chain(chain.id).status).toBe('dead_lettered');
    expect(h.deadLetters()).toEqual([
      expect.objectContaining({
        reason: 'runner_error',
        error: 'refusing to push: conflict markers remain in README.md',
      }),
    ]);
    expect(h.remoteHead(BRANCH)).toBe(before);
    expect(prComments(h, pr, 'conflict-round-1')).toHaveLength(0);
  });

  it('refuses a round whose agent aborted the merge and changed nothing', async () => {
    const h = harness();
    const { chain, pr } = await awaitingMerge(h);
    const before = h.remoteHead(BRANCH);
    h.remote.commit('main', 'README.md', 'main version\n');
    h.host.setMergeable(pr, 'conflicting');
    h.scriptExecute((input) => {
      execFileSync('git', ['merge', '--abort'], { cwd: input.workspace.path, env: GIT_TEST_ENV });
      return ok('aborted');
    });
    await h.maintain();
    await h.runUntilIdle();
    expect(h.chain(chain.id).status).toBe('dead_lettered');
    expect(h.deadLetters()[0]!.error).toContain('the conflict round produced no merge commit');
    expect(h.remoteHead(BRANCH)).toBe(before);
  });

  it('hands a conflict in a binary file to a person with one comment and no agent run', async () => {
    const h = harness();
    const { chain, pr } = await awaitingMerge(h, 'img.bin', Buffer.from([0, 1, 2, 3]) as unknown as string);
    h.remote.commit('main', 'img.bin', Buffer.from([0, 9, 9, 9]));
    h.host.setMergeable(pr, 'conflicting');
    const runs = h.runner.calls.length;
    await h.maintain();
    await h.runUntilIdle();

    expect(h.runner.calls.length).toBe(runs);
    expect(h.chain(chain.id)).toMatchObject({ status: 'waiting', state: { phase: 'needs_human', conflictGaveUp: true } });
    expect(h.issueLabels(N)).toContain(NEEDS_HUMAN);
    expect(h.issueLabels(N)).not.toContain(IN_PROGRESS);
    expect(prComments(h, pr, 'conflict-gave-up')).toHaveLength(1);
    expect(h.jobs(chain.id).at(-1)).toMatchObject({ type: 'execute', status: 'succeeded' });
    expect(eventKinds(h, chain.id)).toContain('conflict.gave_up');

    await h.maintain();
    await h.maintain();
    expect(h.jobs(chain.id).filter((j) => j.type === 'execute')).toHaveLength(2);
    expect(prComments(h, pr, 'conflict-gave-up')).toHaveLength(1);
  });

  it('stops at maxConflictRounds: needs_human, still waiting, one comment', async () => {
    const h = harness({ maxConflictRounds: 1 });
    const { chain, pr } = await awaitingMerge(h);
    h.remote.commit('main', 'README.md', 'main version\n');
    h.host.setMergeable(pr, 'conflicting');
    h.scriptExecute((input, call) => {
      h.write(input, 'README.md', `resolution ${call}\n`);
      return ok('resolved');
    });
    await h.maintain();
    await h.runUntilIdle();
    expect(h.chain(chain.id)).toMatchObject({ status: 'waiting', state: { phase: 'awaiting_merge', conflictRounds: 1 } });

    // Conflicts again: beyond the limit.
    h.remote.commit('main', 'README.md', 'main version 2\n');
    await h.maintain();
    expect(h.chain(chain.id)).toMatchObject({ status: 'waiting', state: { phase: 'needs_human', conflictRounds: 1 } });
    await h.maintain();
    await h.maintain();

    expect(h.jobs(chain.id).filter((j) => j.type === 'execute')).toHaveLength(2);
    expect(prComments(h, pr, 'conflict-round-limit')).toHaveLength(1);
    expect(h.issueLabels(N)).toContain(NEEDS_HUMAN);
    expect(chainEvents(h.db, chain.id).filter((e) => e.kind === 'conflict.gave_up')).toHaveLength(1);
  });

  it('conflict rounds use up neither the review attempts nor the human rounds', async () => {
    const h = harness({ maxHumanRounds: 1 });
    const { chain, pr } = await awaitingMerge(h);
    h.remote.commit('main', 'README.md', 'main version\n');
    h.host.setMergeable(pr, 'conflicting');
    h.scriptExecute((input) => {
      h.write(input, 'README.md', 'resolved\n');
      return ok('resolved');
    });
    await h.maintain();
    await h.runUntilIdle();
    const s = h.chain(chain.id).state;
    expect(s.humanRounds ?? 0).toBe(0);
    expect(s.attemptBase).toBe(s.attempt - 1);
  });

  it('retries `unknown` a few times, then logs once and moves on, doing nothing', async () => {
    const h = harness();
    const { chain, pr } = await awaitingMerge(h);
    h.remote.commit('main', 'README.md', 'main version\n');
    h.host.setMergeable(pr, 'unknown');
    for (let i = 0; i < 8; i++) expect(await h.maintain()).toEqual([]);

    expect(h.chain(chain.id)).toMatchObject({ status: 'waiting', state: { phase: 'awaiting_merge' } });
    expect(h.jobs(chain.id).filter((j) => j.type === 'execute')).toHaveLength(1);
    expect(chainEvents(h.db, chain.id).filter((e) => e.kind === 'conflict.gave_up')).toHaveLength(1);
    const lookups = h.host.calls.filter((c) => c.method === 'findPrByHead').length;
    expect(lookups).toBeGreaterThanOrEqual(8);

    // GitHub finally says it conflicts: a round starts.
    h.host.setMergeable(pr, 'conflicting');
    await h.maintain();
    expect(h.chain(chain.id)).toMatchObject({ status: 'active', state: { conflictRounds: 1 } });
  });

  it('leaves a pull request that is only behind its base alone', async () => {
    const h = harness();
    const { chain, pr } = await awaitingMerge(h);
    h.remote.commit('main', 'other.txt', 'other\n');
    h.host.setMergeable(pr, 'mergeable'); // behind but mergeable
    await h.maintain();
    await h.maintain();
    expect(h.chain(chain.id)).toMatchObject({ status: 'waiting', state: { phase: 'awaiting_merge' } });
    expect(h.jobs(chain.id).filter((j) => j.type === 'execute')).toHaveLength(1);
    expect(h.remoteLog(BRANCH)).toHaveLength(2);
  });

  it('starts nothing when the conflict is gone by the time the round runs', async () => {
    const h = harness();
    const { chain, pr } = await awaitingMerge(h);
    h.remote.commit('main', 'other.txt', 'other\n'); // no real conflict
    h.host.setMergeable(pr, 'conflicting');
    await h.maintain();
    const runs = h.runner.calls.length;
    await h.runUntilIdle();

    expect(h.runner.calls.length).toBe(runs);
    expect(h.chain(chain.id)).toMatchObject({ status: 'waiting', state: { phase: 'awaiting_merge' } });
    expect(h.pr(BRANCH)!.labels).toEqual([READY]);
    expect(h.issueLabels(N)).not.toContain(IN_PROGRESS);
    expect(h.deadLetters()).toEqual([]);
  });

  it('handles the conflict before pending human feedback, then the feedback in sequence', async () => {
    const h = harness();
    const { chain, pr } = await awaitingMerge(h);
    h.remote.commit('main', 'README.md', 'main version\n');
    h.host.setMergeable(pr, 'conflicting');
    h.host.addConversationComment(pr, { createdAt: at(h, 30), body: 'please also add docs' });
    h.scriptExecute((input, call) => {
      h.write(input, call === 0 ? 'README.md' : `rev-${call}.txt`, `v${call}\n`);
      return ok('done');
    });
    await h.maintain();
    const first = h.jobs(chain.id).filter((j) => j.status === 'queued');
    expect(first.map((j) => j.payload)).toEqual([{ conflictRound: 1 }]);
    expect(h.chain(chain.id).state.humanRounds ?? 0).toBe(0);

    await h.runUntilIdle();
    expect(h.chain(chain.id)).toMatchObject({ status: 'waiting', state: { phase: 'awaiting_merge', conflictRounds: 1 } });
    h.host.setMergeable(pr, 'mergeable');
    await h.maintain();
    expect(h.chain(chain.id)).toMatchObject({ status: 'active', state: { phase: 'executing', humanRounds: 1, conflictActive: false } });
    expect(h.jobs(chain.id).filter((j) => j.status === 'queued').map((j) => j.payload)).toEqual([
      expect.objectContaining({ humanRound: 1 }),
    ]);
    await h.runUntilIdle();
    expect(h.chain(chain.id)).toMatchObject({ status: 'waiting', state: { phase: 'awaiting_merge' } });
    expect(prComments(h, pr, 'conflict-round-1')).toHaveLength(1);
    expect(prComments(h, pr, 'human-round-1')).toHaveLength(1);
  });

  it('a person who pushes while the round runs makes the push fail, and the retry starts from the new head', async () => {
    const h = harness();
    const { chain, pr } = await awaitingMerge(h);
    h.remote.commit('main', 'README.md', 'main version\n');
    h.host.setMergeable(pr, 'conflicting');
    let personSha = '';
    h.scriptExecute((input, call) => {
      if (call === 0) {
        personSha = h.remote.commit(BRANCH, 'person.txt', 'by hand\n');
        h.write(input, 'README.md', 'resolved\n');
      } else {
        h.write(input, 'README.md', 'resolved again\n');
      }
      return ok('resolved');
    });
    await h.maintain();
    await h.runOne();
    expect(h.deadLetters()).toEqual([expect.objectContaining({ reason: 'runner_error', error: expect.stringContaining('remote branch moved by someone else') })]);

    await h.kernel.retryDeadLetter(h.deadLetters()[0]!.jobId);
    await h.runUntilIdle();
    expect(h.remoteLog(BRANCH)).toContain(personSha);
    expect(h.remoteFile(BRANCH, 'README.md')).toBe('resolved again');
    expect(h.chain(chain.id)).toMatchObject({ status: 'waiting', state: { phase: 'awaiting_merge' } });
  });
});
