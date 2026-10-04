import { afterEach, describe, expect, it } from 'vitest';
import { chainCost } from '../../src/kernel/inspect.js';
import { chainEvents, recentEvents } from '../../src/kernel/events.js';
import { FAKE_API_KEY, makeHarness, ok, type Harness } from '../support/harness.js';

const N = 7;
const harnesses: Harness[] = [];
const harness = (): Harness => {
  const h = makeHarness();
  harnesses.push(h);
  return h;
};
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

const kinds = (h: Harness, chainId: number) => chainEvents(h.db, chainId).map((e) => e.kind);

describe('lifecycle events', () => {
  it('records execute, review, revise, review and approve in order, with costs per job', async () => {
    const h = harness();
    const { chain } = await h.submit(N);
    h.scriptExecute((input) => {
      h.write(input, `attempt-${input.job.attempt}.txt`, `attempt ${input.job.attempt}\n`);
      return { ...ok(`attempt ${input.job.attempt}`), costUsd: 0.25 };
    });
    h.scriptReview((_input, call) =>
      call === 0
        ? { verdict: 'request_changes', feedback: 'please revise', costUsd: 0.5 }
        : { verdict: 'approve', feedback: 'lgtm', costUsd: 0.125 },
    );
    await h.runUntilIdle();

    expect(kinds(h, chain.id)).toEqual([
      'chain.created',
      'job.queued', // execute 1
      'job.claimed',
      'labels.changed', // claim: in-progress
      'commit.fallback', // the agent left its files uncommitted
      'commit.validated',
      'pr.opened',
      'labels.changed', // execute transition: in-progress
      'job.succeeded',
      'job.queued', // review 1
      'job.claimed',
      'labels.changed',
      'review.verdict', // request_changes
      'job.succeeded',
      'job.queued', // execute 2
      'job.claimed',
      'labels.changed',
      'commit.fallback',
      'commit.validated',
      'labels.changed',
      'job.succeeded',
      'job.queued', // review 2
      'job.claimed',
      'labels.changed',
      'review.verdict', // approve
      'labels.changed', // pr: ready-for-merge
      'labels.changed', // issue: in-progress removed
      'job.succeeded',
      'chain.waiting',
    ]);


    const verdicts = chainEvents(h.db, chain.id).filter((e) => e.kind === 'review.verdict');
    expect(verdicts.map((e) => e.detail)).toEqual([
      { verdict: 'request_changes', attempt: 1 },
      { verdict: 'approve', attempt: 2 },
    ]);
    expect(chainCost(h.db, chain.id).totalUsd).toBeCloseTo(0.25 + 0.5 + 0.25 + 0.125);
  });

  it('comments once when queued and once when work starts, and marks the issue in progress at claim', async () => {
    const h = harness();
    await h.submit(N);
    const queued = h.comments(N);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatch(/event=queued -->$/);
    expect(h.issueLabels(N)).not.toContain('factory:in-progress');

    const job = h.claim()!;
    h.scriptExecute((input) => {
      h.write(input, 'a.txt', 'a\n');
      return ok();
    });
    h.scriptReview([{ verdict: 'approve', feedback: 'lgtm' }]);
    await h.deliver(job);
    expect(h.issueLabels(N)).toContain('factory:in-progress');
    await h.runUntilIdle();
    const markers = h.comments(N).map((c) => /event=(\w+) -->$/.exec(c)?.[1]);
    expect(markers).toEqual(['queued', 'started']);
  });

  it('never stores a planted secret, an issue body or long agent output in an event', async () => {
    const h = harness();
    const { chain } = await h.submit(N);
    h.scriptExecute(() => {
      throw new Error(`agent crashed holding ${FAKE_API_KEY} ${'x'.repeat(500)}`);
    });
    await h.runUntilIdle();
    const rows = h.db.prepare('SELECT * FROM events').all() as { detail: string }[];
    expect(rows.length).toBeGreaterThan(0);
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(FAKE_API_KEY);
    expect(dump).not.toContain('Make the widget work');
    expect(dump).not.toContain('x'.repeat(50));
    expect(kinds(h, chain.id)).toContain('job.dead_lettered');
  });

  it('records requeue, lease loss recovery, retry, discard and cancel', async () => {
    const h = harness();
    const { chain } = await h.submit(N);
    h.claim();
    h.advance(400_000);
    h.reap();
    expect(kinds(h, chain.id).slice(-1)).toEqual(['job.requeued']);
    expect(recentEvents(h.db, { chainId: chain.id, limit: 1 })[0]!.detail).toEqual({ why: 'lease expired' });

    await h.kernel.cancelChain(chain.id);
    expect(kinds(h, chain.id).slice(-1)).toEqual(['chain.cancelled']);

    const second = await h.submit(8);
    h.scriptExecute(() => {
      throw new Error('boom');
    });
    await h.runUntilIdle();
    const jobId = h.jobs(second.chain.id)[0]!.id;
    await h.kernel.retryDeadLetter(jobId);
    await h.runUntilIdle();
    await h.kernel.discardDeadLetter(jobId);
    expect(kinds(h, second.chain.id)).toEqual(
      expect.arrayContaining(['job.dead_lettered', 'dead_letter.retried', 'dead_letter.discarded', 'chain.cancelled']),
    );
  });
});
