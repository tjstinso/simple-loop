import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type Database from 'better-sqlite3';
import { openDb, migrate } from '../../src/kernel/db.js';
import {
  claimNext,
  commitTransition,
  createChain,
  failJob,
  getChain,
  getJob,
  listJobsForChain,
  recordResult,
  renewLease,
  requeueJob,
} from '../../src/kernel/queue.js';
import { StaleDeliveryError } from '../../src/kernel/types.js';
import type { Fence, Job } from '../../src/kernel/types.js';

function mk() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

function seed(db: Database.Database, subjectKey: string, now: number) {
  return createChain(
    db,
    {
      engine: 'e',
      subjectKey,
      engineState: { step: 0 },
      firstJob: { type: 'build', attempt: 1, policyId: 'p', payload: { k: subjectKey } },
    },
    now,
  );
}

const fenceOf = (j: Job): Fence => ({ jobId: j.id, delivery: j.delivery });
const rawJobs = (db: Database.Database) => db.prepare('SELECT * FROM jobs ORDER BY id').all();
const rawChains = (db: Database.Database) => db.prepare('SELECT * FROM chains ORDER BY id').all();

describe('claimNext', () => {
  it('claims the oldest queued job and increments delivery', () => {
    const db = mk();
    const a = seed(db, 'a', 10).job;
    const b = seed(db, 'b', 20).job;

    const j = claimNext(db, 'w1', 100, 5000);
    expect(j).toMatchObject({
      id: a.id,
      status: 'running',
      claimedBy: 'w1',
      leaseExpiresAt: 5100,
      delivery: 1,
    });
    expect(getJob(db, a.id)).toEqual(j);
    expect(db.prepare('SELECT updated_at FROM jobs WHERE id = ?').get(a.id)).toEqual({ updated_at: 100 });

    const k = claimNext(db, 'w2', 200, 5000);
    expect(k).toMatchObject({ id: b.id, claimedBy: 'w2', delivery: 1, leaseExpiresAt: 5200 });

    // Re-claiming a requeued job increments delivery again.
    requeueJob(db, a.id);
    const again = claimNext(db, 'w3', 300, 1000);
    expect(again).toMatchObject({ id: a.id, claimedBy: 'w3', delivery: 2, leaseExpiresAt: 1300 });
  });

  it('returns null when nothing is queued', () => {
    const db = mk();
    expect(claimNext(db, 'w', 1, 1000)).toBeNull();
    seed(db, 'a', 1);
    expect(claimNext(db, 'w', 2, 1000)).not.toBeNull();
    expect(claimNext(db, 'w', 3, 1000)).toBeNull();
  });

  describe('concurrency (file database, separate connections)', () => {
    const N = 8;
    const M = 50;
    let dir: string;
    let dbPath: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'sf-claim-'));
      dbPath = join(dir, 'q.db');
      const setup = openDb(dbPath);
      migrate(setup);
      for (let i = 0; i < M; i++) seed(setup, `s${i}`, i);
      setup.close();
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    function assertExactlyOnce(claims: { id: number; delivery: number }[]) {
      const ids = claims.map((c) => c.id).sort((x, y) => x - y);
      expect(ids).toHaveLength(M);
      expect(new Set(ids).size).toBe(M);
      const check = openDb(dbPath);
      const rows = check.prepare('SELECT id, status, delivery FROM jobs ORDER BY id').all() as {
        id: number;
        status: string;
        delivery: number;
      }[];
      check.close();
      expect(ids).toEqual(rows.map((r) => r.id));
      for (const r of rows) expect(r).toMatchObject({ status: 'running', delivery: 1 });
      for (const c of claims) expect(c.delivery).toBe(1);
    }

    it('N claimers over M jobs never claim a job twice', () => {
      // Round-robin across N connections in one thread. better-sqlite3 is
      // synchronous, so this proves that each connection sees the others'
      // committed claims (no stale snapshot lets a job be claimed twice), but
      // it does not create simultaneous contention for the write lock; the
      // worker_threads test below covers that.
      const conns = Array.from({ length: N }, () => openDb(dbPath));
      const claims: { id: number; delivery: number; by: string }[] = [];
      const done = new Set<number>();
      try {
        while (done.size < N) {
          for (let w = 0; w < N; w++) {
            if (done.has(w)) continue;
            const j = claimNext(conns[w], `w${w}`, 1000, 60_000);
            if (j) claims.push({ id: j.id, delivery: j.delivery, by: `w${w}` });
            else done.add(w);
          }
        }
      } finally {
        for (const c of conns) c.close();
      }
      assertExactlyOnce(claims);
      // Round-robin means every connection got work.
      expect(new Set(claims.map((c) => c.by)).size).toBe(N);
    });

    it('N worker threads racing over M jobs never claim a job twice', async () => {
      // Real parallelism: N threads, each with its own connection, released at
      // the same instant and claiming in a tight loop, so BEGIN IMMEDIATE
      // contention (SQLITE_BUSY + busy_timeout retry) is actually exercised.
      // Scheduling is nondeterministic, so a pass is strong evidence, not proof.
      const gate = new SharedArrayBuffer(8);
      const gateView = new Int32Array(gate);
      const srcDir = new URL('../../src/kernel/', import.meta.url).href;
      const workers = Array.from(
        { length: N },
        (_, w) =>
          new Worker(new URL('./fixtures/claim-worker.mjs', import.meta.url), {
            workerData: { dbPath, workerId: `t${w}`, srcDir, startGate: gate },
          }),
      );
      const results = workers.map(
        (wk) =>
          new Promise<{ id: number; delivery: number; claimedBy: string; status: string }[]>(
            (resolve, reject) => {
              wk.once('message', resolve);
              wk.once('error', reject);
              wk.once('exit', (code) => {
                if (code !== 0) reject(new Error(`worker exited with ${code}`));
              });
            },
          ),
      );
      // Wait until every worker is parked on the gate, then release them all.
      const deadline = Date.now() + 20_000;
      while (Atomics.load(gateView, 1) < N) {
        if (Date.now() > deadline) throw new Error('workers did not reach the start gate');
        await new Promise((r) => setTimeout(r, 5));
      }
      Atomics.store(gateView, 0, 1);
      Atomics.notify(gateView, 0);

      const perWorker = await Promise.all(results);
      const claims = perWorker.flat();
      for (let w = 0; w < N; w++) {
        for (const c of perWorker[w]) expect(c).toMatchObject({ claimedBy: `t${w}`, status: 'running' });
      }
      assertExactlyOnce(claims);
    }, 30_000);
  });
});

describe('fenced writes', () => {
  it('rejects recordResult and commitTransition from a stale delivery', () => {
    const db = mk();
    const { chain, job } = seed(db, 'a', 1);
    const first = claimNext(db, 'w1', 10, 1000)!;
    requeueJob(db, job.id);
    const second = claimNext(db, 'w2', 20, 1000)!;
    expect(second.delivery).toBe(first.delivery + 1);

    const jobsBefore = rawJobs(db);
    const chainsBefore = rawChains(db);
    const stale = fenceOf(first);

    expect(() => recordResult(db, stale, { out: 'stale' })).toThrow(StaleDeliveryError);
    expect(() =>
      commitTransition(
        db,
        stale,
        {
          chainId: chain.id,
          engineState: { step: 99 },
          chainStatus: 'completed',
          newJobs: [{ type: 'deploy', attempt: 1, policyId: 'p' }],
        },
        30,
      ),
    ).toThrow(StaleDeliveryError);
    expect(() => failJob(db, stale, 'boom')).toThrow(StaleDeliveryError);

    expect(rawJobs(db)).toEqual(jobsBefore);
    expect(rawChains(db)).toEqual(chainsBefore);

    // The current fence still works.
    recordResult(db, fenceOf(second), { out: 'ok' });
    expect(getJob(db, job.id).result).toEqual({ out: 'ok' });
  });

  it('rejects fenced writes once the job is no longer running', () => {
    const db = mk();
    const { chain } = seed(db, 'a', 1);
    const j = claimNext(db, 'w', 10, 1000)!;
    commitTransition(
      db,
      fenceOf(j),
      { chainId: chain.id, engineState: { step: 1 }, chainStatus: 'completed', newJobs: [] },
      20,
    );
    // Same delivery, but the job has already succeeded.
    expect(() => recordResult(db, fenceOf(j), 1)).toThrow(StaleDeliveryError);
    expect(() => failJob(db, fenceOf(j), 'late')).toThrow(StaleDeliveryError);
    expect(renewLease(db, fenceOf(j), 30, 1000)).toBe(false);
    expect(getJob(db, j.id)).toMatchObject({ status: 'succeeded', error: null });
  });

  it('renewLease returns false for a stale fence', () => {
    const db = mk();
    const { job } = seed(db, 'a', 1);
    const first = claimNext(db, 'w1', 10, 1000)!;
    expect(renewLease(db, fenceOf(first), 500, 1000)).toBe(true);
    expect(getJob(db, job.id).leaseExpiresAt).toBe(1500);

    requeueJob(db, job.id);
    const second = claimNext(db, 'w2', 600, 1000)!;
    expect(renewLease(db, fenceOf(first), 700, 9999)).toBe(false);
    expect(getJob(db, job.id)).toMatchObject({ leaseExpiresAt: 1600, claimedBy: 'w2' });
    expect(renewLease(db, fenceOf(second), 700, 1000)).toBe(true);
    expect(getJob(db, job.id).leaseExpiresAt).toBe(1700);
  });

  it('recordResult stores the result without finishing the job', () => {
    const db = mk();
    seed(db, 'a', 1);
    const j = claimNext(db, 'w', 10, 1000)!;
    recordResult(db, fenceOf(j), { exit: 0, files: ['a'] });
    expect(getJob(db, j.id)).toMatchObject({ status: 'running', result: { exit: 0, files: ['a'] } });
  });

  it('failJob marks the job failed with the error', () => {
    const db = mk();
    seed(db, 'a', 1);
    const j = claimNext(db, 'w', 10, 1000)!;
    failJob(db, fenceOf(j), 'kaboom');
    expect(getJob(db, j.id)).toMatchObject({ status: 'failed', error: 'kaboom', delivery: 1 });
  });

  it('requeueJob requeues a running job, clears the lease, keeps result and delivery, and returns true', () => {
    const db = mk();
    seed(db, 'a', 1);
    const j = claimNext(db, 'w', 10, 1000)!;
    recordResult(db, fenceOf(j), { partial: true });
    expect(requeueJob(db, j.id)).toBe(true);
    expect(getJob(db, j.id)).toMatchObject({
      status: 'queued',
      claimedBy: null,
      leaseExpiresAt: null,
      delivery: 1,
      result: { partial: true },
    });
    // Matching delivery fence also works.
    const k = claimNext(db, 'w2', 20, 1000)!;
    expect(requeueJob(db, k.id, { delivery: k.delivery })).toBe(true);
    expect(getJob(db, k.id)).toMatchObject({ status: 'queued', delivery: 2, claimedBy: null });
  });

  it('requeueJob leaves a succeeded job succeeded and returns false', () => {
    const db = mk();
    const { chain } = seed(db, 'a', 1);
    const j = claimNext(db, 'w', 10, 1000)!;
    // Reaper observed the running job; the worker commits before the requeue lands.
    commitTransition(
      db,
      fenceOf(j),
      { chainId: chain.id, engineState: { step: 1 }, chainStatus: 'completed', newJobs: [] },
      20,
    );
    const before = rawJobs(db);
    expect(requeueJob(db, j.id)).toBe(false);
    expect(requeueJob(db, j.id, { delivery: j.delivery })).toBe(false);
    expect(rawJobs(db)).toEqual(before);
    expect(getJob(db, j.id).status).toBe('succeeded');
    expect(claimNext(db, 'w2', 30, 1000)).toBeNull();

    // Same for failed and still-queued jobs, and for unknown ids.
    const f = seed(db, 'b', 1).job;
    const fj = claimNext(db, 'w', 40, 1000)!;
    failJob(db, fenceOf(fj), 'x');
    expect(requeueJob(db, f.id)).toBe(false);
    expect(getJob(db, f.id).status).toBe('failed');
    const q = seed(db, 'c', 1).job;
    expect(requeueJob(db, q.id)).toBe(false);
    expect(requeueJob(db, 9999)).toBe(false);
  });

  it('requeueJob returns false and changes nothing when the supplied delivery is stale', () => {
    const db = mk();
    const { job } = seed(db, 'a', 1);
    const first = claimNext(db, 'w1', 10, 1000)!;
    expect(requeueJob(db, job.id, { delivery: first.delivery })).toBe(true);
    const second = claimNext(db, 'w2', 20, 1000)!;
    const before = rawJobs(db);
    expect(requeueJob(db, job.id, { delivery: first.delivery })).toBe(false);
    expect(rawJobs(db)).toEqual(before);
    expect(getJob(db, job.id)).toMatchObject({ status: 'running', claimedBy: 'w2', delivery: second.delivery });
  });
});

describe('commitTransition', () => {
  it('succeeds the job, updates the chain and inserts follow-on jobs in one step', () => {
    const db = mk();
    const { chain } = seed(db, 'a', 1);
    const j = claimNext(db, 'w', 10, 1000)!;
    commitTransition(
      db,
      fenceOf(j),
      {
        chainId: chain.id,
        engineState: { step: 1 },
        chainStatus: 'waiting',
        newJobs: [{ type: 'test', attempt: 1, policyId: 'p2', payload: { x: 1 } }],
      },
      50,
    );
    expect(getJob(db, j.id)).toMatchObject({ status: 'succeeded', delivery: 1 });
    expect(getChain(db, chain.id)).toMatchObject({ status: 'waiting', engineState: { step: 1 } });
    expect(db.prepare('SELECT updated_at FROM chains WHERE id = ?').get(chain.id)).toEqual({ updated_at: 50 });
    const jobs = listJobsForChain(db, chain.id);
    expect(jobs).toHaveLength(2);
    expect(jobs[1]).toMatchObject({
      type: 'test',
      attempt: 1,
      status: 'queued',
      policyId: 'p2',
      payload: { x: 1 },
      delivery: 0,
      claimedBy: null,
      leaseExpiresAt: null,
    });
  });

  it('commitTransition ignores a duplicate follow-on job', () => {
    const db = mk();
    const { chain } = seed(db, 'a', 1);
    const j = claimNext(db, 'w', 10, 1000)!;
    commitTransition(
      db,
      fenceOf(j),
      {
        chainId: chain.id,
        engineState: { step: 1 },
        chainStatus: 'active',
        newJobs: [
          // Duplicate of the existing (build, 1) job.
          { type: 'build', attempt: 1, policyId: 'other', payload: { dup: true } },
          { type: 'test', attempt: 1, policyId: 'p' },
          // Duplicate within the same batch.
          { type: 'test', attempt: 1, policyId: 'p', payload: { dup: true } },
        ],
      },
      50,
    );
    const jobs = listJobsForChain(db, chain.id);
    expect(jobs.map((x) => [x.type, x.attempt, x.status])).toEqual([
      ['build', 1, 'succeeded'],
      ['test', 1, 'queued'],
    ]);
    expect(jobs[0]).toMatchObject({ policyId: 'p', payload: { k: 'a' } });
    expect(jobs[1].payload).toBeNull();
  });
});

describe('claimNext with a concurrency limit', () => {
  it('returns null at the limit and claims again once a slot frees', () => {
    const db = mk();
    seed(db, 'a', 10);
    seed(db, 'b', 20);
    seed(db, 'c', 30);
    const a = claimNext(db, 'w1', 100, 1000, 2)!;
    expect(claimNext(db, 'w2', 100, 1000, 2)).not.toBeNull();
    expect(claimNext(db, 'w3', 100, 1000, 2)).toBeNull();
    failJob(db, fenceOf(a), 'boom');
    expect(claimNext(db, 'w3', 100, 1000, 2)).not.toBeNull();
  });

  it('counts a running job whose lease has expired', () => {
    const db = mk();
    seed(db, 'a', 10);
    seed(db, 'b', 20);
    claimNext(db, 'w1', 100, 1000, 1);
    expect(claimNext(db, 'w2', 1_000_000, 1000, 1)).toBeNull();
  });

  it('is unlimited without a limit', () => {
    const db = mk();
    seed(db, 'a', 10);
    seed(db, 'b', 20);
    expect(claimNext(db, 'w1', 100, 1000)).not.toBeNull();
    expect(claimNext(db, 'w2', 100, 1000)).not.toBeNull();
  });
});
