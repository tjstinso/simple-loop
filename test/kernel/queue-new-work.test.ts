import { describe, expect, it } from 'vitest';
import { migrate, openDb } from '../../src/kernel/db.js';
import { createChain, getChain, listJobsForChain, startWaitingChainWork, updateWaitingChainState } from '../../src/kernel/queue.js';

function mk(status: 'waiting' | 'active' = 'waiting') {
  const db = openDb(':memory:');
  migrate(db);
  const { chain } = createChain(
    db,
    { engine: 'e', subjectKey: 'k', engineState: { n: 1 }, firstJob: { type: 'build', attempt: 1, policyId: 'p' } },
    100,
  );
  db.prepare('UPDATE chains SET status = ? WHERE id = ?').run(status, chain.id);
  return { db, id: chain.id };
}
const job = { type: 'build', attempt: 2, policyId: 'p', payload: { feedback: 'f' } };

describe('startWaitingChainWork', () => {
  it('creates the job, activates the chain and stores the state in one step, once', () => {
    const { db, id } = mk();
    expect(startWaitingChainWork(db, id, { n: 2 }, job, 200)).toBe(true);
    expect(getChain(db, id)).toMatchObject({ status: 'active', engineState: { n: 2 } });
    expect(listJobsForChain(db, id).map((j) => [j.attempt, j.status, j.payload])).toEqual([
      [1, 'queued', null],
      [2, 'queued', { feedback: 'f' }],
    ]);
    // The chain is active now: a second worker's identical answer changes nothing.
    expect(startWaitingChainWork(db, id, { n: 3 }, job, 300)).toBe(false);
    expect(listJobsForChain(db, id)).toHaveLength(2);
    expect(getChain(db, id).engineState).toEqual({ n: 2 });
  });

  it('writes nothing when the chain is not waiting', () => {
    const { db, id } = mk('active');
    expect(startWaitingChainWork(db, id, { n: 2 }, job, 200)).toBe(false);
    expect(listJobsForChain(db, id)).toHaveLength(1);
    expect(getChain(db, id).engineState).toEqual({ n: 1 });
  });

  it('rolls back when the job already exists', () => {
    const { db, id } = mk();
    expect(startWaitingChainWork(db, id, { n: 2 }, { ...job, attempt: 1 }, 200)).toBe(false);
    expect(getChain(db, id)).toMatchObject({ status: 'waiting', engineState: { n: 1 } });
  });
});

describe('updateWaitingChainState', () => {
  it('stores the state only while the chain is waiting', () => {
    const w = mk();
    expect(updateWaitingChainState(w.db, w.id, { n: 9 }, 200)).toBe(true);
    expect(getChain(w.db, w.id)).toMatchObject({ status: 'waiting', engineState: { n: 9 } });
    const a = mk('active');
    expect(updateWaitingChainState(a.db, a.id, { n: 9 }, 200)).toBe(false);
    expect(getChain(a.db, a.id).engineState).toEqual({ n: 1 });
  });
});
