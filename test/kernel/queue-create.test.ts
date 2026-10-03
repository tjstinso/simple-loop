import { describe, it, expect } from 'vitest';
import { openDb, migrate } from '../../src/kernel/db.js';
import {
  DuplicateChainError,
  createChain,
  getChain,
  getJob,
  listJobsForChain,
} from '../../src/kernel/queue.js';

function mk() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}
const first = { type: 'build', attempt: 1, policyId: 'p', payload: { a: 1 } };

describe('createChain', () => {
  it('creates a chain and a queued job atomically', () => {
    const db = mk();
    const { chain, job } = createChain(
      db,
      { engine: 'e', subjectKey: 'k1', engineState: { n: 1 }, firstJob: first },
      100,
    );
    expect(chain).toMatchObject({ engine: 'e', subjectKey: 'k1', status: 'active', engineState: { n: 1 } });
    expect(job).toMatchObject({
      chainId: chain.id,
      type: 'build',
      attempt: 1,
      status: 'queued',
      policyId: 'p',
      payload: { a: 1 },
      result: null,
      claimedBy: null,
      leaseExpiresAt: null,
      delivery: 0,
      error: null,
    });
    expect(getChain(db, chain.id)).toEqual(chain);
    expect(getJob(db, job.id)).toEqual(job);
    expect(listJobsForChain(db, chain.id)).toEqual([job]);
  });

  it('stores undefined payload as null', () => {
    const db = mk();
    const { job } = createChain(
      db,
      { engine: 'e', subjectKey: 'k', engineState: {}, firstJob: { type: 't', attempt: 1, policyId: 'p' } },
      1,
    );
    expect(job.payload).toBeNull();
  });

  it('throws DuplicateChainError for an open subject', () => {
    const db = mk();
    const args = { engine: 'e', subjectKey: 'dup', engineState: {}, firstJob: first };
    createChain(db, args, 1);
    expect(() => createChain(db, args, 2)).toThrow(DuplicateChainError);
  });

  it('does not leave a chain behind when job insert fails', () => {
    const db = mk();
    const bad = { ...first, type: null as unknown as string };
    expect(() =>
      createChain(db, { engine: 'e', subjectKey: 'x', engineState: {}, firstJob: bad }, 1),
    ).toThrow();
    expect(db.prepare('SELECT COUNT(*) AS n FROM chains').get()).toEqual({ n: 0 });
  });
});
