import { describe, it, expect } from 'vitest';
import { openDb, migrate } from '../../src/kernel/db.js';
import { claimNext, createChain, getChain, getJob, recordResult } from '../../src/kernel/queue.js';
import { recordChild, registerWorker, liveChildrenFor } from '../../src/kernel/workers.js';
import { listDeadLetters } from '../../src/kernel/dlq.js';
import { reapExpired } from '../../src/kernel/reaper.js';

function mk() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}
const first = { type: 'build', attempt: 1, policyId: 'p', payload: {} };

function claimed(db: ReturnType<typeof mk>, key = 'k1', now = 100, leaseMs = 1000) {
  createChain(db, { engine: 'e', subjectKey: key, engineState: {}, firstJob: first }, now);
  registerWorker(db, { id: 'w1', pid: 4001, pgid: 4001, startTime: 5, host: 'h' }, now);
  return claimNext(db, 'w1', now, leaseMs)!;
}
const status = (db: ReturnType<typeof mk>, id: number) => getJob(db, id).status;
const alive = () => true;
const boom = () => {
  throw new Error('must not be called');
};

describe('reaper', () => {
  it('requeues a running job whose lease expired', () => {
    const db = mk();
    const job = claimed(db);
    const r = reapExpired(db, { now: 2000, maxDeliveries: 3, isAlive: () => false, killGroup: boom, killPid: boom });
    expect(r).toEqual({ requeued: [job.id], deadLettered: [], killed: [] });
    expect(getJob(db, job.id)).toMatchObject({ status: 'queued', claimedBy: null, leaseExpiresAt: null });
  });

  it('kills live children of that delivery before requeueing', () => {
    const db = mk();
    const job = claimed(db);
    recordChild(db, { workerId: 'w1', jobId: job.id, delivery: job.delivery, pid: 5001, pgid: 5001, startTime: 7 }, 110);
    const seen: string[] = [];
    const r = reapExpired(db, {
      now: 2000,
      maxDeliveries: 3,
      isAlive: (pid) => pid === 5001,
      killGroup: (pg) => {
        seen.push(`g${pg}:${status(db, job.id)}`);
      },
      killPid: boom,
    });
    expect(seen).toEqual(['g5001:running']);
    expect(status(db, job.id)).toBe('queued');
    expect(r.killed).toEqual([5001]);
    expect(liveChildrenFor(db, job.id, job.delivery)).toEqual([]);
  });

  it('does not touch a job whose lease is still valid', () => {
    const db = mk();
    const job = claimed(db); // lease expires at 1100
    const r = reapExpired(db, { now: 1100, maxDeliveries: 3, isAlive: alive, killGroup: boom, killPid: boom });
    expect(r).toEqual({ requeued: [], deadLettered: [], killed: [] });
    expect(status(db, job.id)).toBe('running');
  });

  it('dead-letters with max_deliveries once delivery reaches maxDeliveries', () => {
    const db = mk();
    const job = claimed(db);
    const r = reapExpired(db, { now: 2000, maxDeliveries: job.delivery, isAlive: () => false, killGroup: boom, killPid: boom });
    expect(r).toEqual({ requeued: [], deadLettered: [job.id], killed: [] });
    expect(getJob(db, job.id).status).toBe('failed');
    expect(getChain(db, job.chainId).status).toBe('dead_lettered');
    const dl = listDeadLetters(db)[0]!;
    expect(dl.reason).toBe('max_deliveries');
    expect(dl.error).toContain(String(job.id));
    expect(dl.error).toContain(String(job.delivery));
  });

  it('kills the claiming worker by pid (never its group) when still alive', () => {
    const db = mk();
    const job = claimed(db);
    const pids: number[] = [];
    const r = reapExpired(db, {
      now: 2000,
      maxDeliveries: 3,
      isAlive: (pid) => pid === 4001,
      killGroup: boom,
      killPid: (pid) => {
        pids.push(pid);
        expect(status(db, job.id)).toBe('running');
      },
    });
    expect(pids).toEqual([4001]);
    expect(r.killed).toEqual([4001]);
    expect(r.requeued).toEqual([job.id]);
  });

  it('never signals its own pid but still requeues', () => {
    const db = mk();
    const job = claimed(db);
    registerWorker(db, { id: 'w1', pid: process.pid, pgid: process.pid, startTime: 5, host: 'h' }, 100);
    const r = reapExpired(db, { now: 2000, maxDeliveries: 3, isAlive: alive, killGroup: () => {}, killPid: boom });
    expect(r.killed).toEqual([]);
    expect(r.requeued).toEqual([job.id]);
  });

  it('does not report or alter a job that raced to succeeded', () => {
    const db = mk();
    const job = claimed(db);
    const r = reapExpired(db, {
      now: 2000,
      maxDeliveries: 3,
      isAlive: (pid) => pid === 4001,
      killGroup: boom,
      killPid: () => {
        db.prepare(`UPDATE jobs SET status = 'succeeded' WHERE id = ?`).run(job.id);
      },
    });
    expect(r.requeued).toEqual([]);
    expect(r.deadLettered).toEqual([]);
    expect(status(db, job.id)).toBe('succeeded');
  });

  it('only considers running jobs', () => {
    const db = mk();
    const job = claimed(db);
    db.prepare(`UPDATE jobs SET status = 'queued' WHERE id = ?`).run(job.id); // stale lease column kept
    const r = reapExpired(db, { now: 2000, maxDeliveries: 3, isAlive: alive, killGroup: boom, killPid: boom });
    expect(r).toEqual({ requeued: [], deadLettered: [], killed: [] });
  });

  it('requeues a job that already has a result, keeping the result', () => {
    const db = mk();
    const job = claimed(db);
    recordResult(db, { jobId: job.id, delivery: job.delivery }, { ok: 1 });
    const r = reapExpired(db, { now: 2000, maxDeliveries: 3, isAlive: () => false, killGroup: boom, killPid: boom });
    expect(r.requeued).toEqual([job.id]);
    expect(getJob(db, job.id).result).toEqual({ ok: 1 });
  });
});
