import type Database from 'better-sqlite3';
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
      return { chain: getChain(db, chainId), job: getJob(db, Number(r.lastInsertRowid)) };
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
 */
export function claimNext(db: Db, workerId: string, now: number, leaseMs: number): Job | null {
  const claim = db.transaction((): Job | null => {
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
    return r ? rowToJob(r) : null;
  });
  return claim.immediate();
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
          RETURNING chain_id`,
      )
      .get(now, fence.jobId, fence.delivery) as { chain_id: number } | undefined;
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
    for (const j of args.newJobs) {
      ins.run(args.chainId, j.type, j.attempt, j.policyId, json(j.payload), now, now);
    }
  }).immediate();
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
 * Put a job back on the queue and clear its lease. Not fenced: this is the
 * kernel's recovery path (expired lease, worker crash). `result` and
 * `delivery` are kept, so the next claim gets delivery + 1 and any write from
 * the previous holder is rejected. `updated_at` is left unchanged because no
 * clock value is passed in.
 */
export function requeueJob(db: Db, jobId: number): void {
  const r = db
    .prepare(
      `UPDATE jobs SET status = 'queued', claimed_by = NULL, lease_expires_at = NULL
        WHERE id = ?`,
    )
    .run(jobId);
  if (r.changes !== 1) throw new Error(`job ${jobId} not found`);
}
