import { describe, expect, it } from 'vitest';
import { migrate, openDb } from '../../src/kernel/db.js';
import { EVENT_TEXT_MAX, chainEvents, recentEvents, recordEvent } from '../../src/kernel/events.js';
import { claimNext, commitTransition, createChain, requeueJob } from '../../src/kernel/queue.js';

const mk = () => {
  const db = openDb(':memory:');
  migrate(db);
  return db;
};
const first = { type: 'build', attempt: 1, policyId: 'p' };

describe('events', () => {
  it('stores events with null job and delivery by default and caps long strings', () => {
    const db = mk();
    recordEvent(db, { at: 5, chainId: 1, kind: 'x', engine: 'kernel', detail: { text: 'y'.repeat(1000), n: 1 } });
    const [e] = chainEvents(db, 1);
    expect(e).toMatchObject({ at: 5, jobId: null, delivery: null, kind: 'x', engine: 'kernel' });
    expect((e!.detail.text as string).length).toBe(EVENT_TEXT_MAX);
    expect(e!.detail.n).toBe(1);
  });

  it('records the kernel transitions in the transaction that makes them', () => {
    const db = mk();
    const { chain, job } = createChain(db, { engine: 'e', subjectKey: 's', engineState: {}, firstJob: first }, 10);
    const claimed = claimNext(db, 'w1', 20, 1000)!;
    expect(requeueJob(db, job.id, { delivery: claimed.delivery, now: 30, why: 'test' })).toBe(true);
    const again = claimNext(db, 'w1', 40, 1000)!;
    commitTransition(
      db,
      { jobId: job.id, delivery: again.delivery },
      { chainId: chain.id, engineState: {}, chainStatus: 'waiting', newJobs: [{ type: 'next', attempt: 1, policyId: 'p' }] },
      50,
    );
    expect(chainEvents(db, chain.id).map((e) => [e.at, e.kind, e.delivery])).toEqual([
      [10, 'chain.created', null],
      [10, 'job.queued', 0],
      [20, 'job.claimed', 1],
      [30, 'job.requeued', 1],
      [40, 'job.claimed', 2],
      [50, 'job.succeeded', 2],
      [50, 'job.queued', 0],
      [50, 'chain.waiting', null],
    ]);
    expect(requeueJob(db, job.id)).toBe(false);
    expect(recentEvents(db, { since: 45 }).map((e) => e.kind)).toEqual(['job.succeeded', 'job.queued', 'chain.waiting']);
    expect(recentEvents(db, { limit: 2 }).map((e) => e.kind)).toEqual(['job.queued', 'chain.waiting']);
  });
});
