import { describe, it, expect } from 'vitest';
import { openDb, migrate } from '../../src/kernel/db.js';
import { claimNext, createChain, getChain, getJob, recordResult } from '../../src/kernel/queue.js';
import { recordChild, registerWorker, liveChildrenFor, setWorkerJob } from '../../src/kernel/workers.js';
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
  const job = claimNext(db, 'w1', now, leaseMs)!;
  setWorkerJob(db, 'w1', job.id, job.delivery); // as the worker loop does at claim
  return job;
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
    const r = reapExpired(db, { now: 2000, maxDeliveries: 3, groupProbe: () => false, isAlive: () => false, killGroup: boom, killPid: boom });
    expect(r).toEqual({ requeued: [job.id], deadLettered: [], killed: [], errors: [] });
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
      groupProbe: () => false, isAlive: (pid) => pid === 5001,
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
    const r = reapExpired(db, { now: 1100, maxDeliveries: 3, groupProbe: () => false, isAlive: alive, killGroup: boom, killPid: boom });
    expect(r).toEqual({ requeued: [], deadLettered: [], killed: [], errors: [] });
    expect(status(db, job.id)).toBe('running');
  });

  it('dead-letters with max_deliveries once delivery reaches maxDeliveries', () => {
    const db = mk();
    const job = claimed(db);
    const r = reapExpired(db, { now: 2000, maxDeliveries: job.delivery, groupProbe: () => false, isAlive: () => false, killGroup: boom, killPid: boom });
    expect(r).toEqual({ requeued: [], deadLettered: [job.id], killed: [], errors: [] });
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
      groupProbe: () => false, isAlive: (pid) => pid === 4001,
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
    const r = reapExpired(db, { now: 2000, maxDeliveries: 3, groupProbe: () => false, isAlive: alive, killGroup: () => {}, killPid: boom });
    expect(r.killed).toEqual([]);
    expect(r.requeued).toEqual([job.id]);
  });

  it('does not report or alter a job that raced to succeeded', () => {
    const db = mk();
    const job = claimed(db);
    const r = reapExpired(db, {
      now: 2000,
      maxDeliveries: 3,
      groupProbe: () => false, isAlive: (pid) => pid === 4001,
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
    const r = reapExpired(db, { now: 2000, maxDeliveries: 3, groupProbe: () => false, isAlive: alive, killGroup: boom, killPid: boom });
    expect(r).toEqual({ requeued: [], deadLettered: [], killed: [], errors: [] });
  });

  it('requeues a job that already has a result, keeping the result', () => {
    const db = mk();
    const job = claimed(db);
    recordResult(db, { jobId: job.id, delivery: job.delivery }, { ok: 1 });
    const r = reapExpired(db, { now: 2000, maxDeliveries: 3, groupProbe: () => false, isAlive: () => false, killGroup: boom, killPid: boom });
    expect(r.requeued).toEqual([job.id]);
    expect(getJob(db, job.id).result).toEqual({ ok: 1 });
  });

  // Two expired jobs; job 1's kill hook mutates job 2 after the reaper's snapshot.
  function two(db: ReturnType<typeof mk>) {
    const j1 = claimed(db, 'k1');
    createChain(db, { engine: 'e', subjectKey: 'k2', engineState: {}, firstJob: first }, 100);
    registerWorker(db, { id: 'w2', pid: 4002, pgid: 4002, startTime: 6, host: 'h' }, 100);
    const j2 = claimNext(db, 'w2', 100, 1000)!;
    setWorkerJob(db, 'w2', j2.id, j2.delivery);
    return { j1, j2 };
  }
  function run(db: ReturnType<typeof mk>, j1Id: number, mutate: () => void, killed: number[]) {
    return reapExpired(db, {
      now: 2000, maxDeliveries: 3, groupProbe: () => false, isAlive: () => true, killGroup: boom,
      killPid: (pid) => {
        killed.push(pid);
        if (pid === 4001) mutate();
      },
    });
  }

  it('does not kill when the job heartbeat extended its lease after the snapshot', () => {
    const db = mk();
    const { j1, j2 } = two(db);
    const killed: number[] = [];
    const r = run(db, j1.id, () => db.prepare('UPDATE jobs SET lease_expires_at = 9999 WHERE id = ?').run(j2.id), killed);
    expect(killed).toEqual([4001]);
    expect(r.requeued).toEqual([j1.id]);
    expect(status(db, j2.id)).toBe('running');
  });

  it('does not kill the worker when the job already succeeded or moved to a new delivery', () => {
    for (const sql of [
      `UPDATE jobs SET status = 'succeeded' WHERE id = ?`,
      `UPDATE jobs SET delivery = delivery + 1 WHERE id = ?`,
    ]) {
      const db = mk();
      const { j1, j2 } = two(db);
      const killed: number[] = [];
      const r = run(db, j1.id, () => db.prepare(sql).run(j2.id), killed);
      expect(killed).toEqual([4001]);
      expect(r.requeued).toEqual([j1.id]);
      expect(r.killed).toEqual([4001]);
    }
  });

  it('kills the group when the leader is dead but the probe says members remain', () => {
    const db = mk();
    const job = claimed(db);
    recordChild(db, { workerId: 'w1', jobId: job.id, delivery: job.delivery, pid: 5001, pgid: 5001, startTime: 7 }, 110);
    const groups: number[] = [];
    const r = reapExpired(db, {
      now: 2000, maxDeliveries: 3, isAlive: () => false, groupProbe: (pg) => pg === 5001,
      killGroup: (pg) => { groups.push(pg); }, killPid: boom,
    });
    expect(groups).toEqual([5001]);
    expect(r.killed).toEqual([5001]);
    expect(r.requeued).toEqual([job.id]);
  });

  it('kills nothing when both the leader and the group are gone', () => {
    const db = mk();
    const job = claimed(db);
    recordChild(db, { workerId: 'w1', jobId: job.id, delivery: job.delivery, pid: 5001, pgid: 5001, startTime: 7 }, 110);
    const r = reapExpired(db, {
      now: 2000, maxDeliveries: 3, isAlive: () => false, groupProbe: () => false, killGroup: boom, killPid: boom,
    });
    expect(r.killed).toEqual([]);
    expect(r.requeued).toEqual([job.id]);
    expect(liveChildrenFor(db, job.id, job.delivery)).toEqual([]);
  });

  it('records an error and continues when a kill throws, and later jobs are still reaped', () => {
    const db = mk();
    const { j1, j2 } = two(db);
    const r = reapExpired(db, {
      now: 2000, maxDeliveries: 3, isAlive: () => true, groupProbe: () => false, killGroup: boom,
      killPid: (pid) => { if (pid === 4001) throw new Error('EPERM'); },
    });
    expect(r.errors).toEqual([{ jobId: j1.id, error: 'EPERM' }]);
    expect(status(db, j1.id)).toBe('running');
    expect(r.requeued).toEqual([j2.id]);
  });

  it('does not kill a worker that moved on to another job, but still reclaims the expired one', () => {
    const db = mk();
    const job = claimed(db);
    // The worker abandoned this delivery (thrown / lease lost) and now works on job 999.
    setWorkerJob(db, 'w1', 999, 1);
    const r = reapExpired(db, { now: 2000, maxDeliveries: 3, groupProbe: () => false, isAlive: alive, killGroup: boom, killPid: boom });
    expect(r.killed).toEqual([]);
    expect(r.requeued).toEqual([job.id]);
  });

  it('does not kill a worker that is idle or on another delivery of the same job', () => {
    for (const set of [
      (db: ReturnType<typeof mk>) => setWorkerJob(db, 'w1', null, null),
      (db: ReturnType<typeof mk>, id: number, d: number) => setWorkerJob(db, 'w1', id, d + 1),
    ]) {
      const db = mk();
      const job = claimed(db);
      set(db, job.id, job.delivery);
      const r = reapExpired(db, { now: 2000, maxDeliveries: 3, groupProbe: () => false, isAlive: alive, killGroup: boom, killPid: boom });
      expect(r.killed).toEqual([]);
      expect(r.requeued).toEqual([job.id]);
    }
  });

  it('kills a worker still on the expired delivery', () => {
    const db = mk();
    const job = claimed(db);
    const row = db.prepare('SELECT current_job_id, current_delivery FROM workers WHERE id = ?').get('w1');
    expect(row).toEqual({ current_job_id: job.id, current_delivery: job.delivery });
    const pids: number[] = [];
    const r = reapExpired(db, { now: 2000, maxDeliveries: 3, groupProbe: () => false, isAlive: alive, killGroup: boom, killPid: (p) => void pids.push(p) });
    expect(pids).toEqual([4001]);
    expect(r.killed).toEqual([4001]);
  });
});
