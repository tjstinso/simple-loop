import { describe, it, expect } from 'vitest';
import { openDb, migrate } from '../../src/kernel/db.js';
import { claimNext, commitTransition, createChain, getChain, getJob, listJobsForChain, recordResult, scheduleTransientRetry, transientRetryDelayMs } from '../../src/kernel/queue.js';
import {
  DeadLetterStateError,
  cancelChain,
  deadLetter,
  discardDeadLetter,
  listDeadLetters,
  listUnsurfacedDeadLetters,
  markDeadLetterSurfaced,
  retryDeadLetter,
} from '../../src/kernel/dlq.js';

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
    const dl = deadLetter(db, { jobId: job.id, reason: 'runner_error', error: 'boom' }, 200);
    expect(dl).toMatchObject({
      jobId: job.id, chainId: chain.id, reason: 'runner_error', error: 'boom',
      createdAt: 200, resolvedAt: null,
    });
    expect(getJob(db, job.id)).toMatchObject({ status: 'failed', error: 'boom' });
    expect(getChain(db, chain.id).status).toBe('dead_lettered');
  });

  it('works on a queued job and rejects an unknown job', () => {
    const db = mk();
    const { job } = createChain(db, { engine: 'e', subjectKey: 'q', engineState: {}, firstJob: first }, 1);
    expect(deadLetter(db, { jobId: job.id, reason: 'max_deliveries', error: 'x' }, 2).jobId).toBe(job.id);
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

  it('retry resets the transient-retry backoff so it is driven by the count, not the history', () => {
    const db = mk();
    const { job } = setup(db);
    db.prepare('UPDATE jobs SET transient_retries = 3 WHERE id = ?').run(job.id);
    const n = scheduleTransientRetry(db, { jobId: job.id, delivery: job.delivery }, 1000, 'net')!;
    expect(n.count).toBe(4);
    expect(getJob(db, job.id).availableAt).toBe(1000 + transientRetryDelayMs(3));

    const again = claimNext(db, 'w1', 1000 + transientRetryDelayMs(3), 1000)!;
    deadLetter(db, { jobId: job.id, reason: 'runner_error', error: 'boom' }, 2000);
    const r = retryDeadLetter(db, job.id, 3000);
    expect(r.transientRetries).toBe(0);
    expect(r.availableAt).toBeNull();

    const claimed = claimNext(db, 'w2', 3000, 1000)!;
    expect(claimed.delivery).toBe(again.delivery + 1);
    const s = scheduleTransientRetry(db, { jobId: job.id, delivery: claimed.delivery }, 4000, 'net')!;
    expect(s).toEqual({ delayMs: transientRetryDelayMs(0), count: 1 });
    expect(getJob(db, job.id).availableAt).toBe(4000 + transientRetryDelayMs(0));
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

  it('refuses to dead-letter a succeeded job and leaves job and chain untouched', () => {
    const db = mk();
    const { chain, job } = setup(db);
    db.prepare("UPDATE jobs SET status='succeeded' WHERE id=?").run(job.id);
    expect(() => deadLetter(db, { jobId: job.id, reason: 'timeout', error: 'e' }, 200)).toThrow(DeadLetterStateError);
    expect(() => deadLetter(db, { jobId: job.id, reason: 'timeout', error: 'e' }, 200)).toThrow(
      new RegExp(`job ${job.id}.*succeeded`),
    );
    expect(getJob(db, job.id)).toMatchObject({ status: 'succeeded', error: null });
    expect(getChain(db, chain.id).status).toBe('active');
    expect(listDeadLetters(db)).toHaveLength(0);
  });

  it('refuses to dead-letter a job on a cancelled chain and leaves the chain cancelled', () => {
    const db = mk();
    const { chain, job } = setup(db);
    db.prepare("UPDATE chains SET status='cancelled' WHERE id=?").run(chain.id);
    expect(() => deadLetter(db, { jobId: job.id, reason: 'timeout', error: 'e' }, 200)).toThrow(DeadLetterStateError);
    expect(getChain(db, chain.id).status).toBe('cancelled');
    expect(getJob(db, job.id).status).toBe('running');
    expect(listDeadLetters(db)).toHaveLength(0);
  });

  it('refuses to dead-letter a job on a completed chain', () => {
    const db = mk();
    const { chain, job } = setup(db);
    db.prepare("UPDATE chains SET status='completed' WHERE id=?").run(chain.id);
    expect(() => deadLetter(db, { jobId: job.id, reason: 'timeout', error: 'e' }, 200)).toThrow(/completed/);
    expect(getChain(db, chain.id).status).toBe('completed');
  });

  it('retry still refuses a cancelled chain after a refused dead-letter attempt', () => {
    const db = mk();
    const { chain, job } = setup(db);
    db.prepare("UPDATE chains SET status='cancelled' WHERE id=?").run(chain.id);
    expect(() => deadLetter(db, { jobId: job.id, reason: 'timeout', error: 'e' }, 200)).toThrow(DeadLetterStateError);
    expect(() => retryDeadLetter(db, job.id, 300)).toThrow(/no unresolved dead letter/);
    expect(getChain(db, chain.id).status).toBe('cancelled');
  });

  it('a repeated deadLetter call on an already dead-lettered job still returns the existing row', () => {
    const db = mk();
    const { job } = setup(db);
    const a = deadLetter(db, { jobId: job.id, reason: 'timeout', error: 'a' }, 200);
    expect(getJob(db, job.id).status).toBe('failed');
    expect(deadLetter(db, { jobId: job.id, reason: 'runner_error', error: 'b' }, 300)).toEqual(a);
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

  it('a new dead letter is unsurfaced until markDeadLetterSurfaced records the time', () => {
    const db = mk();
    const { job } = setup(db);
    const dl = deadLetter(db, { jobId: job.id, reason: 'timeout', error: 'x' }, 200);
    expect(dl).toMatchObject({ id: expect.any(Number), surfacedAt: null });
    expect(listUnsurfacedDeadLetters(db).map((d) => d.jobId)).toEqual([job.id]);
    markDeadLetterSurfaced(db, dl.id, 250);
    expect(listDeadLetters(db)[0]).toMatchObject({ jobId: job.id, surfacedAt: 250 });
    expect(listUnsurfacedDeadLetters(db)).toEqual([]);
  });

  it('listUnsurfacedDeadLetters skips resolved dead letters', () => {
    const db = mk();
    const a = setup(db, 'a');
    const b = setup(db, 'b');
    deadLetter(db, { jobId: a.job.id, reason: 'timeout', error: 'x' }, 200);
    deadLetter(db, { jobId: b.job.id, reason: 'timeout', error: 'y' }, 201);
    discardDeadLetter(db, a.job.id, 300);
    expect(listUnsurfacedDeadLetters(db).map((d) => d.jobId)).toEqual([b.job.id]);
  });

  it('cancelChain cancels a waiting chain and its queued jobs and frees the subject key', () => {
    const db = mk();
    const { chain, job } = setup(db);
    commitTransition(
      db,
      { jobId: job.id, delivery: job.delivery },
      { chainId: chain.id, engineState: { s: 1 }, chainStatus: 'waiting', newJobs: [{ type: 'next', attempt: 1, policyId: 'p' }] },
      150,
    );
    const cancelled = cancelChain(db, chain.id, 300);
    expect(cancelled).toMatchObject({ id: chain.id, status: 'cancelled' });
    expect(getChain(db, chain.id).status).toBe('cancelled');
    expect(listJobsForChain(db, chain.id).map((j) => j.status)).toEqual(['succeeded', 'cancelled']);
    expect(() => createChain(db, { engine: 'e', subjectKey: 'k1', engineState: {}, firstJob: first }, 400)).not.toThrow();
  });

  it("cancelChain resolves the chain's unresolved dead letters", () => {
    const db = mk();
    const { chain, job } = setup(db);
    deadLetter(db, { jobId: job.id, reason: 'runner_error', error: 'x' }, 200);
    cancelChain(db, chain.id, 300);
    expect(getChain(db, chain.id).status).toBe('cancelled');
    expect(listDeadLetters(db, { unresolved: true })).toEqual([]);
    expect(listDeadLetters(db)[0]!.resolvedAt).toBe(300);
    expect(getJob(db, job.id).status).toBe('failed');
  });

  it('cancelChain refuses a chain with a running job and writes nothing', () => {
    const db = mk();
    const { chain, job } = setup(db);
    expect(() => cancelChain(db, chain.id, 300)).toThrow(new RegExp(`job ${job.id} is running`));
    expect(getChain(db, chain.id).status).toBe('active');
    expect(getJob(db, job.id).status).toBe('running');
  });

  it('cancelChain refuses an unknown, completed or already cancelled chain', () => {
    const db = mk();
    expect(() => cancelChain(db, 99, 1)).toThrow(/chain 99 not found/);
    const { chain } = createChain(db, { engine: 'e', subjectKey: 'c', engineState: {}, firstJob: first }, 100);
    db.prepare("UPDATE chains SET status = 'completed' WHERE id = ?").run(chain.id);
    expect(() => cancelChain(db, chain.id, 1)).toThrow(/is completed/);
    db.prepare("UPDATE chains SET status = 'cancelled' WHERE id = ?").run(chain.id);
    expect(() => cancelChain(db, chain.id, 1)).toThrow(/is cancelled/);
  });
});
