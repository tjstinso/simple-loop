import { afterEach, describe, expect, it } from 'vitest';
import type { Check } from '../../src/engines/software/github.js';
import { chainEvents } from '../../src/kernel/events.js';
import { makeHarness, ok, type Harness, type HarnessOptions } from '../support/harness.js';

const N = 7;
const BRANCH = `factory/issue-${N}`;
const AUTO = ['factory:profile:automatic'];
const READY = 'factory:ready-for-merge';
const NEEDS_HUMAN = 'factory:needs-human';
const MIN = 60_000;
const JOB_URL = 'https://github.com/o/r/actions/runs/11/job/42';
const SECRET = 'sk-ant-' + 'x'.repeat(30);

const harnesses: Harness[] = [];
const harness = (opts?: HarnessOptions): Harness => {
  const h = makeHarness(opts);
  harnesses.push(h);
  return h;
};
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

const pass = (name: string): Check => ({ name, status: 'completed', conclusion: 'success' });
const fail = (name: string, detailsUrl?: string): Check => ({
  name, status: 'completed', conclusion: 'failure', ...(detailsUrl ? { detailsUrl } : {}),
});
const running = (name: string): Check => ({ name, status: 'in_progress', conclusion: null });

/** Submits #N, runs the agent and the reviewer (approving `approvals` times); leaves the chain at the gate. */
async function toGate(h: Harness, labels: string[] = AUTO, approvals = 1) {
  const { chain } = await h.submit(N, labels);
  h.scriptExecute((input) => {
    h.write(input, `attempt-${input.job.attempt}.txt`, `attempt ${input.job.attempt}\n`);
    return ok(`attempt ${input.job.attempt}`);
  });
  h.scriptReview(Array.from({ length: approvals }, () => ({ verdict: 'approve' as const, feedback: 'lgtm' })));
  await h.runUntilIdle();
  return chain;
}

const mergeCalls = (h: Harness) => h.host.calls.filter((c) => c.method === 'mergePr');
const checkCalls = (h: Harness) => h.host.calls.filter((c) => c.method === 'getChecks').map((c) => c.args[1]);
const ciEvents = (h: Harness, chainId: number, kind: string) => chainEvents(h.db, chainId).filter((e) => e.kind === kind);
const prComments = (h: Harness) => h.comments(8).filter((c) => !/event=(queued|started) -->/.test(c));

describe('CI gate scenarios', () => {
  it('waits at the gate after the approval instead of merging', async () => {
    const h = harness({ ci: { required: 'all' } });
    const chain = await toGate(h);
    expect(h.chain(chain.id)).toMatchObject({ status: 'waiting', state: { phase: 'awaiting_ci', reviewedSha: h.remoteHead(BRANCH) } });
    expect(mergeCalls(h)).toEqual([]);
  });

  it('merges at once when the checks already pass, pinned to the reviewed head', async () => {
    const h = harness({ ci: { required: 'all' } });
    const chain = await toGate(h);
    const sha = h.remoteHead(BRANCH)!;
    h.host.setChecks(sha, [pass('check (node 22)'), pass('check (node 24)')]);

    expect(await h.maintain()).toEqual([]);

    expect(h.chain(chain.id)).toMatchObject({ status: 'completed', state: { phase: 'merged' } });
    expect(h.pr(BRANCH)).toMatchObject({ state: 'merged' });
    expect(mergeCalls(h).map((c) => c.args)).toEqual([['o/r', 8, { expectHeadSha: sha }]]);
    expect(checkCalls(h)).toEqual([sha]);
    expect(ciEvents(h, chain.id, 'ci.checked').map((e) => e.detail)).toEqual([{ sha, state: 'passing', failing: [] }]);
  });

  it('pending, then passing on a later pass: merges then', async () => {
    const h = harness({ ci: { required: 'all' } });
    const chain = await toGate(h);
    const sha = h.remoteHead(BRANCH)!;
    h.host.setChecks(sha, [pass('check (node 22)'), running('check (node 24)')]);

    await h.maintain();
    h.advance(MIN);
    await h.maintain();

    expect(h.chain(chain.id)).toMatchObject({ status: 'waiting', state: { phase: 'awaiting_ci' } });
    expect(mergeCalls(h)).toEqual([]);
    // One event per state change, not one per pass.
    expect(ciEvents(h, chain.id, 'ci.waiting')).toHaveLength(1);
    expect(ciEvents(h, chain.id, 'ci.checked')).toHaveLength(1);

    h.host.setChecks(sha, [pass('check (node 22)'), pass('check (node 24)')]);
    h.advance(MIN);
    await h.maintain();

    expect(h.chain(chain.id).status).toBe('completed');
    expect(mergeCalls(h)).toHaveLength(1);
    expect(ciEvents(h, chain.id, 'ci.checked')).toHaveLength(2);
  });

  it('failing: the revision gets the failure as feedback, then passing merges; old checks are never reused', async () => {
    const h = harness({ ci: { required: 'all' } });
    const chain = await toGate(h, AUTO, 2);
    const oldSha = h.remoteHead(BRANCH)!;
    h.host.setChecks(oldSha, [fail('check (node 22)', JOB_URL), pass('check (node 24)')]);
    h.host.setJobLog(42, `${'noise\n'.repeat(300)}FAIL src/widget.test.ts\ntoken ${SECRET}\n`);

    await h.maintain();

    expect(h.chain(chain.id)).toMatchObject({ status: 'active', state: { phase: 'executing', attempt: 2 } });
    expect(h.chain(chain.id).state.reviewedSha).toBeUndefined();
    expect(ciEvents(h, chain.id, 'ci.failed')[0]?.detail).toMatchObject({ sha: oldSha, action: 'revise', failing: ['check (node 22)'] });

    await h.runUntilIdle();

    const feedback = h.callsOf('execute')[1]!.feedback!;
    expect(feedback).toContain('check (node 22): failure');
    expect(feedback).toContain(JOB_URL);
    expect(feedback).toContain('FAIL src/widget.test.ts');
    expect(feedback).not.toContain(SECRET);
    expect(feedback.split('\n').filter((l) => l === 'noise').length).toBeLessThanOrEqual(200);
    const newSha = h.remoteHead(BRANCH)!;
    expect(newSha).not.toBe(oldSha);
    expect(h.chain(chain.id).state).toMatchObject({ phase: 'awaiting_ci', attempt: 2, reviewedSha: newSha });
    expect(h.callsOf('review')).toHaveLength(2);

    // The old head's failing checks still stand, but the new head's checks decide.
    h.host.setChecks(newSha, [pass('check (node 22)'), pass('check (node 24)')]);
    await h.maintain();

    expect(h.chain(chain.id).status).toBe('completed');
    expect(mergeCalls(h).map((c) => c.args)).toEqual([['o/r', 8, { expectHeadSha: newSha }]]);
    expect(checkCalls(h)).toEqual([oldSha, newSha]);
  });

  it('ignores passing checks of an old sha while the reviewed head has none finished', async () => {
    const h = harness({ ci: { required: 'all' } });
    const chain = await toGate(h);
    h.host.setChecks('some-older-sha', [pass('check (node 22)')]);
    h.host.setChecks(h.remoteHead(BRANCH)!, [running('check (node 22)')]);

    await h.maintain();

    expect(h.chain(chain.id).status).toBe('waiting');
    expect(mergeCalls(h)).toEqual([]);
  });

  it('failing past maxAttempts: needs_human with one comment naming the failing checks', async () => {
    const h = harness({ ci: { required: 'all' } });
    const chain = await toGate(h, AUTO, 3);
    for (let attempt = 1; attempt <= 3; attempt++) {
      h.host.setChecks(h.remoteHead(BRANCH)!, [fail('check (node 22)'), pass('check (node 24)')]);
      await h.maintain();
      if (attempt < 3) await h.runUntilIdle();
    }

    expect(h.chain(chain.id)).toMatchObject({ status: 'waiting', state: { phase: 'needs_human', attempt: 3 } });
    expect(h.callsOf('execute')).toHaveLength(3);
    expect(prComments(h)).toHaveLength(1);
    expect(prComments(h)[0]).toContain('check (node 22)');
    expect(prComments(h)[0]).toContain('event=ci-failed');
    expect(h.pr(BRANCH)!.labels).toContain(NEEDS_HUMAN);

    await h.maintain();
    expect(prComments(h)).toHaveLength(1);
    expect(mergeCalls(h)).toEqual([]);
  });

  it('onFailure hold: needs_human at once, no new attempt', async () => {
    const h = harness({ ci: { required: 'all', onFailure: 'hold' } });
    const chain = await toGate(h);
    h.host.setChecks(h.remoteHead(BRANCH)!, [fail('check (node 22)')]);

    await h.maintain();

    expect(h.chain(chain.id)).toMatchObject({ status: 'waiting', state: { phase: 'needs_human', attempt: 1 } });
    expect(h.jobs(chain.id).filter((j) => j.type === 'execute')).toHaveLength(1);
    expect(ciEvents(h, chain.id, 'ci.failed')[0]?.detail).toMatchObject({ action: 'hold' });
  });

  it('wait timeout: needs_human with one comment', async () => {
    const h = harness({ ci: { required: 'all', waitMinutes: 5 } });
    const chain = await toGate(h);
    h.host.setChecks(h.remoteHead(BRANCH)!, [running('check (node 22)')]);

    h.advance(4 * MIN);
    await h.maintain();
    expect(h.chain(chain.id).state.phase).toBe('awaiting_ci');

    h.advance(2 * MIN);
    await h.maintain();
    await h.maintain();

    expect(h.chain(chain.id)).toMatchObject({ status: 'waiting', state: { phase: 'needs_human' } });
    expect(prComments(h)).toHaveLength(1);
    expect(prComments(h)[0]).toContain('CI did not finish within 5 minutes');
    expect(ciEvents(h, chain.id, 'ci.timeout')).toHaveLength(1);
    expect(mergeCalls(h)).toEqual([]);
  });

  it('no checks with onNone hold (the default): needs_human', async () => {
    const h = harness({ ci: { required: 'all' } });
    const chain = await toGate(h);

    await h.maintain();

    expect(h.chain(chain.id)).toMatchObject({ status: 'waiting', state: { phase: 'needs_human' } });
    expect(mergeCalls(h)).toEqual([]);
    expect(prComments(h)).toHaveLength(1);
  });

  it('no checks with onNone merge: merges', async () => {
    const h = harness({ ci: { required: 'all', onNone: 'merge' } });
    const chain = await toGate(h);

    await h.maintain();

    expect(h.chain(chain.id).status).toBe('completed');
    expect(mergeCalls(h)).toHaveLength(1);
  });

  it('a list of required checks ignores the others', async () => {
    const h = harness({ ci: { required: ['check (node 22)'] } });
    const chain = await toGate(h);
    h.host.setChecks(h.remoteHead(BRANCH)!, [pass('check (node 22)'), fail('lint')]);

    await h.maintain();

    expect(h.chain(chain.id).status).toBe('completed');
  });

  it('a policy without ci merges as before and never reads checks', async () => {
    const h = harness();
    const chain = await toGate(h);

    expect(h.chain(chain.id)).toMatchObject({ status: 'completed', state: { phase: 'merged' } });
    expect(mergeCalls(h)).toHaveLength(1);
    expect(checkCalls(h)).toEqual([]);
    expect(h.chain(chain.id).state.reviewedSha).toBeUndefined();
  });

  it('a person merging the pull request while it waits completes the chain', async () => {
    const h = harness({ ci: { required: 'all' } });
    const chain = await toGate(h);
    h.host.setChecks(h.remoteHead(BRANCH)!, [running('check (node 22)')]);
    h.host.prs.get(8)!.state = 'merged';

    await h.maintain();

    expect(h.chain(chain.id)).toMatchObject({ status: 'completed', state: { phase: 'merged' } });
    expect(mergeCalls(h)).toEqual([]);
  });

  it('a push after the review blocks the merge and hands over to a person', async () => {
    const h = harness({ ci: { required: 'all' } });
    const chain = await toGate(h);
    h.host.setChecks(h.remoteHead(BRANCH)!, [pass('check (node 22)')]);
    h.host.setPrHead(8, 'moved');
    h.host.headShaOf = null;

    await h.maintain();

    expect(h.chain(chain.id)).toMatchObject({ status: 'waiting', state: { phase: 'needs_human' } });
    expect(h.pr(BRANCH)!.state).toBe('open');
  });

  describe('supervised profile', () => {
    it('posts the CI result once, when it is passing or failing', async () => {
      const h = harness({ ci: { required: 'all' } });
      const chain = await toGate(h, []);
      const sha = h.remoteHead(BRANCH)!;
      expect(h.chain(chain.id)).toMatchObject({ status: 'waiting', state: { phase: 'awaiting_merge', reviewedSha: sha } });
      expect(h.pr(BRANCH)!.labels).toEqual([READY]);

      h.host.setChecks(sha, [pass('check (node 22)'), running('check (node 24)')]);
      await h.maintain();
      expect(prComments(h)).toEqual([]);

      h.host.setChecks(sha, [pass('check (node 22)'), fail('check (node 24)', 'https://example.test/x')]);
      await h.maintain();
      await h.maintain();

      expect(prComments(h)).toHaveLength(1);
      expect(prComments(h)[0]).toContain('CI failing');
      expect(prComments(h)[0]).toContain('check (node 24): failure');
      expect(mergeCalls(h)).toEqual([]);
      expect(h.chain(chain.id).state.phase).toBe('awaiting_merge');
    });

    it('without a ci policy nothing is read or posted', async () => {
      const h = harness();
      await toGate(h, []);
      await h.maintain();
      expect(checkCalls(h)).toEqual([]);
      expect(prComments(h)).toEqual([]);
    });
  });
});
