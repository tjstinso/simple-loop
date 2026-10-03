import { describe, it, expect } from 'vitest';
import { openDb, migrate } from '../../src/kernel/db.js';
import { claimNext, createChain, getChain, getJob, recordResult } from '../../src/kernel/queue.js';
import { deadLetter, discardDeadLetter, listDeadLetters, retryDeadLetter } from '../../src/kernel/dlq.js';

function mk() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}
const first = { type: 'build', attempt: 2, policyId: 'p', payload: { a: 1 } };

function setup(db: ReturnType<typeof mk>, key = 'k1') {
  const { chain, job } = createChain(db, { engine: 'e', subjectKey: key, engineState: {}, firstJob: first }, 100);
  const claimed = claimNext(db, 'w1', 110, 1000)!;
  expect(claimed.id).toBe(job.id);
  return { chain, job: claimed };
}

describe('dead-letter queue', () => {
  it('moves the job to failed and the chain to dead_lettered', () => {
    const db = mk();
    const { chain, job } = setup(db);
    const dl = deadLetter(db, { jobId: job.id, reason: 'runner_error', error: 'boom', stepLogPath: '/l' }, 200);
    expect(dl).toMatchObject({
      jobId: job.id, chainId: chain.id, reason: 'runner_error', error: 'boom',
      stepLogPath: '/l', createdAt: 200, resolvedAt: null,
    });
    expect(getJob(db, job.id)).toMatchObject({ status: 'failed', error: 'boom' });
    expect(getChain(db, chain.id).status).toBe('dead_lettered');
  });

  it('works on a queued job and rejects an unknown job', () => {
    const db = mk();
    const { job } = createChain(db, { engine: 'e', subjectKey: 'q', engineState: {}, firstJob: first }, 1);
    expect(deadLetter(db, { jobId: job.id, reason: 'max_deliveries', error: 'x' }, 2).stepLogPath).toBeNull();
    expect(() => deadLetter(db, { jobId: 999, reason: 'timeout', error: 'x' }, 2)).toThrow(/not found/);
  });

  it('does not insert a second unresolved dead letter for the same job', () => {
    const db = mk();
    const { job } = setup(db);
    const a = deadLetter(db, { jobId: job.id, reason: 'timeout', error: 'a' }, 200);
    const b = deadLetter(db, { jobId: job.id, reason: 'runner_error', error: 'b' }, 300);
    expect(b).toEqual(a);
    expect(listDeadLetters(db)).toHaveLength(1);
  });

  it('retry re-queues the same job with the same type, attempt and payload', () => {
    const db = mk();
    const { chain, job } = setup(db);
    deadLetter(db, { jobId: job.id, reason: 'runner_error', error: 'boom' }, 200);
    const r = retryDeadLetter(db, job.id, 300);
    expect(r).toMatchObject({
      id: job.id, chainId: chain.id, type: 'build', attempt: 2, payload: { a: 1 },
      status: 'queued', error: null, claimedBy: null, leaseExpiresAt: null, delivery: job.delivery,
    });
    expect(getChain(db, chain.id).status).toBe('active');
    expect(listDeadLetters(db)[0]!.resolvedAt).toBe(300);
    expect(claimNext(db, 'w2', 400, 1000)!.delivery).toBe(job.delivery + 1);
  });

  it('retry after effect_error keeps the recorded result', () => {
    const db = mk();
    const { job } = setup(db);
    recordResult(db, { jobId: job.id, delivery: job.delivery }, { out: 7 });
    deadLetter(db, { jobId: job.id, reason: 'effect_error', error: 'e' }, 200);
    expect(retryDeadLetter(db, job.id, 300).result).toEqual({ out: 7 });
  });

  it('retry after runner_error starts without a result', () => {
    const db = mk();
    const { job } = setup(db);
    recordResult(db, { jobId: job.id, delivery: job.delivery }, { out: 7 });
    deadLetter(db, { jobId: job.id, reason: 'runner_error', error: 'e' }, 200);
    expect(retryDeadLetter(db, job.id, 300).result).toBeNull();
  });

  it('retry of a resolved dead letter or a cancelled chain throws', () => {
    const db = mk();
    const { job } = setup(db);
    deadLetter(db, { jobId: job.id, reason: 'timeout', error: 'e' }, 200);
    retryDeadLetter(db, job.id, 300);
    expect(() => retryDeadLetter(db, job.id, 301)).toThrow(/no unresolved dead letter/);

    const db2 = mk();
    const s2 = setup(db2);
    deadLetter(db2, { jobId: s2.job.id, reason: 'timeout', error: 'e' }, 200);
    db2.prepare("UPDATE chains SET status='cancelled' WHERE id=?").run(s2.chain.id);
    expect(() => retryDeadLetter(db2, s2.job.id, 300)).toThrow(/not dead_lettered/);
    expect(getChain(db2, s2.chain.id).status).toBe('cancelled');
    expect(getJob(db2, s2.job.id).status).toBe('failed');
  });

  it('discard cancels the chain and frees the subject key', () => {
    const db = mk();
    const { chain, job } = setup(db);
    deadLetter(db, { jobId: job.id, reason: 'timeout', error: 'e' }, 200);
    discardDeadLetter(db, job.id, 300);
    expect(getChain(db, chain.id).status).toBe('cancelled');
    expect(getJob(db, job.id).status).toBe('failed');
    expect(listDeadLetters(db)[0]!.resolvedAt).toBe(300);
    expect(() => createChain(db, { engine: 'e', subjectKey: 'k1', engineState: {}, firstJob: first }, 400)).not.toThrow();
    expect(() => discardDeadLetter(db, job.id, 500)).toThrow(/no unresolved dead letter/);
  });

  it('listDeadLetters filters unresolved and orders newest first', () => {
    const db = mk();
    const a = setup(db, 'a');
    const b = createChain(db, { engine: 'e', subjectKey: 'b', engineState: {}, firstJob: first }, 120).job;
    deadLetter(db, { jobId: a.job.id, reason: 'timeout', error: 'e' }, 200);
    deadLetter(db, { jobId: b.id, reason: 'timeout', error: 'e' }, 250);
    discardDeadLetter(db, a.job.id, 300);
    expect(listDeadLetters(db).map((d) => d.jobId)).toEqual([b.id, a.job.id]);
    expect(listDeadLetters(db, { unresolved: true }).map((d) => d.jobId)).toEqual([b.id]);
  });
});
