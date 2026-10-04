import type Database from 'better-sqlite3';
import { recordEvent } from './events.js';
import { StaleDeliveryError } from './types.js';
import type { Chain, ChainStatus, Fence, Job, JobStatus, ResolvedNewJob } from './types.js';

export class DuplicateChainError extends Error {
  constructor(message = 'an open chain already exists for this subject') {
    super(message);
    this.name = 'DuplicateChainError';
  }
}

type Db = Database.Database;

export interface ChainRow {
  id: number;
  engine: string;
  subject_key: string;
  status: string;
  engine_state: string;
  created_at: number;
  updated_at: number;
}

export interface JobRow {
  id: number;
  chain_id: number;
  type: string;
  attempt: number;
  status: string;
  policy_id: string;
  payload: string | null;
  result: string | null;
  claimed_by: string | null;
  lease_expires_at: number | null;
  delivery: number;
  error: string | null;
  created_at: number;
  updated_at: number;
}

export function rowToChain(r: ChainRow): Chain {
  return {
    id: r.id,
    engine: r.engine,
    subjectKey: r.subject_key,
    status: r.status as ChainStatus,
    engineState: JSON.parse(r.engine_state),
  };
}

export function rowToJob(r: JobRow): Job {
  return {
    id: r.id,
    chainId: r.chain_id,
    type: r.type,
    attempt: r.attempt,
    status: r.status as JobStatus,
    policyId: r.policy_id,
    payload: r.payload === null ? null : JSON.parse(r.payload),
    result: r.result === null ? null : JSON.parse(r.result),
    claimedBy: r.claimed_by,
    leaseExpiresAt: r.lease_expires_at,
    delivery: r.delivery,
    error: r.error,
  };
}

export function getChain(db: Db, id: number): Chain {
  const r = db.prepare('SELECT * FROM chains WHERE id = ?').get(id) as ChainRow | undefined;
  if (!r) throw new Error(`chain ${id} not found`);
  return rowToChain(r);
}

export function getJob(db: Db, id: number): Job {
  const r = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
  if (!r) throw new Error(`job ${id} not found`);
  return rowToJob(r);
}

export function listJobsForChain(db: Db, chainId: number): Job[] {
  const rows = db.prepare('SELECT * FROM jobs WHERE chain_id = ? ORDER BY id').all(chainId) as JobRow[];
  return rows.map(rowToJob);
}

export function createChain(
  db: Db,
  args: { engine: string; subjectKey: string; engineState: unknown; firstJob: ResolvedNewJob },
  now: number,
): { chain: Chain; job: Job } {
  try {
    return db.transaction(() => {
      const c = db
        .prepare(
          `INSERT INTO chains (engine, subject_key, status, engine_state, created_at, updated_at)
           VALUES (?, ?, 'active', ?, ?, ?)`,
        )
        .run(args.engine, args.subjectKey, JSON.stringify(args.engineState), now, now);
      const chainId = Number(c.lastInsertRowid);
      const j = args.firstJob;
      const r = db
        .prepare(
          `INSERT INTO jobs (chain_id, type, attempt, status, policy_id, payload, delivery, created_at, updated_at)
           VALUES (?, ?, ?, 'queued', ?, ?, 0, ?, ?)`,
        )
        .run(
          chainId,
          j.type,
          j.attempt,
          j.policyId,
          j.payload === undefined ? null : JSON.stringify(j.payload),
          now,
          now,
        );
      const jobId = Number(r.lastInsertRowid);
      recordEvent(db, { at: now, chainId, kind: 'chain.created', engine: 'kernel', detail: { subject: args.subjectKey, engine: args.engine } });
      recordEvent(db, { at: now, chainId, jobId, delivery: 0, kind: 'job.queued', engine: 'kernel', detail: { type: j.type, attempt: j.attempt } });
      return { chain: getChain(db, chainId), job: getJob(db, jobId) };
    })();
  } catch (e) {
    if (
      e instanceof Error &&
      (e as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE' &&
      /chains\.subject_key/.test(e.message)
    ) {
      throw new DuplicateChainError();
    }
    throw e;
  }
}

const json = (v: unknown): string | null => (v === undefined ? null : JSON.stringify(v));

/**
 * Atomically claim the oldest queued job. Runs under BEGIN IMMEDIATE so the
 * write lock is taken before the job is selected; at most one connection can
 * be inside this transaction at a time, and each sees all earlier claims.
 * Every claim increments `delivery`, which becomes the fence for later writes.
 * With `maxConcurrent`, nothing is claimed (null) while that many jobs are `running`, counted in
 * the same transaction; a running job with an expired lease counts until the reaper reclaims it.
 */
export function claimNext(db: Db, workerId: string, now: number, leaseMs: number, maxConcurrent?: number): Job | null {
  const claim = db.transaction((): Job | null => {
    if (maxConcurrent !== undefined && countRunning(db) >= maxConcurrent) return null;
    const r = db
      .prepare(
        `UPDATE jobs
            SET status = 'running', claimed_by = ?, lease_expires_at = ?,
                delivery = delivery + 1, updated_at = ?
          WHERE id = (SELECT id FROM jobs WHERE status = 'queued' ORDER BY id LIMIT 1)
            AND status = 'queued'
          RETURNING *`,
      )
      .get(workerId, now + leaseMs, now) as JobRow | undefined;
    if (!r) return null;
    recordEvent(db, {
      at: now,
      chainId: r.chain_id,
      jobId: r.id,
      delivery: r.delivery,
      kind: 'job.claimed',
      engine: 'kernel',
      detail: { worker: workerId, type: r.type, attempt: r.attempt },
    });
    return rowToJob(r);
  });
  return claim.immediate();
}

/** The number of jobs with status `running`. */
export function countRunning(db: Db): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE status = 'running'`).get() as { n: number }).n;
}

/** At most one `job.throttled` event per this interval. */
export const THROTTLE_EVENT_INTERVAL_MS = 60_000;

/**
 * Records `job.throttled` (against the oldest queued job) when the limit is reached and work is
 * queued, unless one was recorded within the last minute by any worker. Returns whether it recorded.
 */
export function recordThrottled(db: Db, now: number, limit: number): boolean {
  return db
    .transaction((): boolean => {
      const running = countRunning(db);
      if (running < limit) return false;
      const next = db.prepare(`SELECT id, chain_id FROM jobs WHERE status = 'queued' ORDER BY id LIMIT 1`).get() as
        | { id: number; chain_id: number }
        | undefined;
      if (!next) return false;
      const recent = db
        .prepare(`SELECT 1 FROM events WHERE at > ? AND kind = 'job.throttled' LIMIT 1`)
        .get(now - THROTTLE_EVENT_INTERVAL_MS);
      if (recent !== undefined) return false;
      recordEvent(db, {
        at: now,
        chainId: next.chain_id,
        jobId: next.id,
        kind: 'job.throttled',
        engine: 'kernel',
        detail: { running, limit },
      });
      return true;
    })
    .immediate();
}

/** Extend the lease of a running job. Returns false if the fence is stale. */
export function renewLease(db: Db, fence: Fence, now: number, leaseMs: number): boolean {
  const r = db
    .prepare(
      `UPDATE jobs SET lease_expires_at = ?, updated_at = ?
        WHERE id = ? AND delivery = ? AND status = 'running'`,
    )
    .run(now + leaseMs, now, fence.jobId, fence.delivery);
  return r.changes === 1;
}

/** Store a running job's result. Throws StaleDeliveryError if the fence is stale. */
export function recordResult(db: Db, fence: Fence, result: unknown): void {
  const r = db
    .prepare(
      `UPDATE jobs SET result = ?
        WHERE id = ? AND delivery = ? AND status = 'running'`,
    )
    .run(json(result), fence.jobId, fence.delivery);
  if (r.changes !== 1) throw new StaleDeliveryError();
}

/** The `costUsd` a job result carries, if any. */
export function costOf(result: string | null): number | undefined {
  if (result === null) return undefined;
  try {
    const c = (JSON.parse(result) as { costUsd?: unknown } | null)?.costUsd;
    return typeof c === 'number' && Number.isFinite(c) ? c : undefined;
  } catch {
    return undefined;
  }
}

/**
 * In one transaction: mark the fenced job succeeded, update its chain's state
 * and status, and enqueue follow-on jobs. Follow-ons that collide with an
 * existing (chain_id, type, attempt) are ignored, so a replayed transition
 * cannot create duplicates. `attempt` is accepted for interface compatibility
 * and currently unused.
 */
export function commitTransition(
  db: Db,
  fence: Fence,
  args: {
    chainId: number;
    engineState: unknown;
    chainStatus: ChainStatus;
    newJobs: ResolvedNewJob[];
    attempt?: number;
  },
  now: number,
): void {
  db.transaction(() => {
    const done = db
      .prepare(
        `UPDATE jobs SET status = 'succeeded', lease_expires_at = NULL, updated_at = ?
          WHERE id = ? AND delivery = ? AND status = 'running'
          RETURNING chain_id, type, attempt, result`,
      )
      .get(now, fence.jobId, fence.delivery) as
      | { chain_id: number; type: string; attempt: number; result: string | null }
      | undefined;
    if (!done) throw new StaleDeliveryError();
    if (done.chain_id !== args.chainId) {
      throw new Error(`job ${fence.jobId} belongs to chain ${done.chain_id}, not ${args.chainId}`);
    }
    const c = db
      .prepare('UPDATE chains SET engine_state = ?, status = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(args.engineState), args.chainStatus, now, args.chainId);
    if (c.changes !== 1) throw new Error(`chain ${args.chainId} not found`);
    const ins = db.prepare(
      `INSERT OR IGNORE INTO jobs
         (chain_id, type, attempt, status, policy_id, payload, delivery, created_at, updated_at)
       VALUES (?, ?, ?, 'queued', ?, ?, 0, ?, ?)`,
    );
    const cost = costOf(done.result);
    recordEvent(db, {
      at: now,
      chainId: args.chainId,
      jobId: fence.jobId,
      delivery: fence.delivery,
      kind: 'job.succeeded',
      engine: 'kernel',
      detail: { type: done.type, attempt: done.attempt, ...(cost === undefined ? {} : { costUsd: cost }) },
    });
    for (const j of args.newJobs) {
      const added = ins.run(args.chainId, j.type, j.attempt, j.policyId, json(j.payload), now, now);
      if (added.changes === 1) {
        recordEvent(db, {
          at: now,
          chainId: args.chainId,
          jobId: Number(added.lastInsertRowid),
          delivery: 0,
          kind: 'job.queued',
          engine: 'kernel',
          detail: { type: j.type, attempt: j.attempt },
        });
      }
    }
    if (args.chainStatus === 'completed' || args.chainStatus === 'waiting') {
      recordEvent(db, { at: now, chainId: args.chainId, kind: `chain.${args.chainStatus}`, engine: 'kernel' });
    }
  }).immediate();
}

/**
 * Completes a chain that is still `waiting`, storing `engineState`, in one transaction. Returns false
 * (writing nothing) when the chain is in any other status, so concurrent reconcilers and a manual
 * cancel cannot overwrite each other.
 */
export function completeWaitingChain(db: Db, chainId: number, engineState: unknown, now: number): boolean {
  const r = db
    .prepare(
      `UPDATE chains SET status = 'completed', engine_state = ?, updated_at = ? WHERE id = ? AND status = 'waiting'`,
    )
    .run(JSON.stringify(engineState), now, chainId);
  if (r.changes === 1) recordEvent(db, { at: now, chainId, kind: 'chain.completed', engine: 'kernel', detail: { by: 'reconcile' } });
  return r.changes === 1;
}

/**
 * Starts new work for a chain that is still `waiting`, in one transaction: creates the job (queued),
 * sets the chain `active` and stores `engineState`. Returns false (writing nothing) when the chain is
 * in any other status or the job already exists, so two workers cannot start the same work twice.
 */
export function startWaitingChainWork(
  db: Db,
  chainId: number,
  engineState: unknown,
  job: ResolvedNewJob,
  now: number,
): boolean {
  try {
    return startWork(db, chainId, engineState, job, now);
  } catch (e) {
    if (e instanceof RollbackSignal) return false;
    throw e;
  }
}

class RollbackSignal extends Error {}

function startWork(db: Db, chainId: number, engineState: unknown, job: ResolvedNewJob, now: number): boolean {
  return db
    .transaction((): boolean => {
      const r = db
        .prepare(`UPDATE chains SET status = 'active', engine_state = ?, updated_at = ? WHERE id = ? AND status = 'waiting'`)
        .run(JSON.stringify(engineState), now, chainId);
      if (r.changes !== 1) return false;
      const added = db
        .prepare(
          `INSERT OR IGNORE INTO jobs
             (chain_id, type, attempt, status, policy_id, payload, delivery, created_at, updated_at)
           VALUES (?, ?, ?, 'queued', ?, ?, 0, ?, ?)`,
        )
        .run(chainId, job.type, job.attempt, job.policyId, json(job.payload), now, now);
      // The job exists already (a duplicate round): roll the whole change back.
      if (added.changes !== 1) throw new RollbackSignal();
      recordEvent(db, { at: now, chainId, kind: 'chain.active', engine: 'kernel', detail: { by: 'reconcile' } });
      recordEvent(db, {
        at: now,
        chainId,
        jobId: Number(added.lastInsertRowid),
        delivery: 0,
        kind: 'job.queued',
        engine: 'kernel',
        detail: { type: job.type, attempt: job.attempt },
      });
      return true;
    })
    .immediate();
}

/** Stores `engineState` of a chain that is still `waiting` (false, writing nothing, otherwise). */
export function updateWaitingChainState(db: Db, chainId: number, engineState: unknown, now: number): boolean {
  const r = db
    .prepare(`UPDATE chains SET engine_state = ?, updated_at = ? WHERE id = ? AND status = 'waiting'`)
    .run(JSON.stringify(engineState), now, chainId);
  return r.changes === 1;
}

/** Mark a running job failed. Throws StaleDeliveryError if the fence is stale. */
export function failJob(db: Db, fence: Fence, error: string): void {
  const r = db
    .prepare(
      `UPDATE jobs SET status = 'failed', error = ?, lease_expires_at = NULL
        WHERE id = ? AND delivery = ? AND status = 'running'`,
    )
    .run(error, fence.jobId, fence.delivery);
  if (r.changes !== 1) throw new StaleDeliveryError();
}

/**
 * Put a running job back on the queue and clear its lease: the kernel's
 * recovery path (expired lease, worker crash). Only a `running` job is
 * requeued, and when `opts.delivery` is given only that delivery, so a reaper
 * racing a worker's commit cannot resurrect a finished job. Returns false
 * (a no-op) otherwise. `result` and `delivery` are kept, so the next claim gets
 * delivery + 1 and any write from the previous holder is rejected.
 * `updated_at` is left unchanged because no clock value is passed in.
 */
export function requeueJob(db: Db, jobId: number, opts: { delivery?: number; now?: number; why?: string } = {}): boolean {
  const sql = `UPDATE jobs SET status = 'queued', claimed_by = NULL, lease_expires_at = NULL
                WHERE id = ? AND status = 'running'`;
  return db
    .transaction((): boolean => {
      const r = (
        opts.delivery === undefined
          ? db.prepare(`${sql} RETURNING chain_id, delivery`).get(jobId)
          : db.prepare(`${sql} AND delivery = ? RETURNING chain_id, delivery`).get(jobId, opts.delivery)
      ) as { chain_id: number; delivery: number } | undefined;
      if (!r) return false;
      recordEvent(db, {
        at: opts.now ?? Date.now(),
        chainId: r.chain_id,
        jobId,
        delivery: r.delivery,
        kind: 'job.requeued',
        engine: 'kernel',
        detail: { why: opts.why ?? 'requeued' },
      });
      return true;
    })
    .immediate();
}
