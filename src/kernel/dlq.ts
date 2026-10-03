import type Database from 'better-sqlite3';
import { getJob } from './queue.js';
import type { DeadLetter, DeadLetterReason, Job } from './types.js';

type Db = Database.Database;

interface DeadLetterRow {
  id: number;
  job_id: number;
  chain_id: number;
  reason: string;
  error: string;
  step_log_path: string | null;
  created_at: number;
  resolved_at: number | null;
  surfaced_at: number | null;
}

/** Thrown by deadLetter when the job or its chain is already in a terminal state. */
export class DeadLetterStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeadLetterStateError';
  }
}

function rowToDeadLetter(r: DeadLetterRow): DeadLetter {
  return {
    id: r.id,
    jobId: r.job_id,
    chainId: r.chain_id,
    reason: r.reason as DeadLetterReason,
    error: r.error,
    stepLogPath: r.step_log_path,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
    surfacedAt: r.surfaced_at,
  };
}

function findUnresolved(db: Db, jobId: number): DeadLetterRow | undefined {
  return db
    .prepare('SELECT * FROM dead_letters WHERE job_id = ? AND resolved_at IS NULL ORDER BY id DESC LIMIT 1')
    .get(jobId) as DeadLetterRow | undefined;
}

/**
 * In one transaction: mark the job failed, the chain dead_lettered, and record
 * a dead letter. Deliberately not fenced; the caller decides whether to fence
 * first. Idempotent per job: if an unresolved dead letter already exists it is
 * returned and nothing is written, so the DLQ never holds duplicates.
 */
export function deadLetter(
  db: Db,
  args: { jobId: number; reason: DeadLetterReason; error: string; stepLogPath?: string },
  now: number,
): DeadLetter {
  return db
    .transaction((): DeadLetter => {
      const job = db.prepare('SELECT chain_id, status FROM jobs WHERE id = ?').get(args.jobId) as
        | { chain_id: number; status: string }
        | undefined;
      if (!job) throw new Error(`job ${args.jobId} not found`);
      const existing = findUnresolved(db, args.jobId);
      if (existing) return rowToDeadLetter(existing);
      if (job.status === 'succeeded' || job.status === 'cancelled') {
        throw new DeadLetterStateError(`cannot dead-letter job ${args.jobId}: job is ${job.status}`);
      }
      const chain = db.prepare('SELECT status FROM chains WHERE id = ?').get(job.chain_id) as
        | { status: string }
        | undefined;
      if (chain && (chain.status === 'cancelled' || chain.status === 'completed')) {
        throw new DeadLetterStateError(
          `cannot dead-letter job ${args.jobId}: chain ${job.chain_id} is ${chain.status}`,
        );
      }
      db.prepare(
        `UPDATE jobs SET status = 'failed', error = ?, lease_expires_at = NULL, updated_at = ? WHERE id = ?`,
      ).run(args.error, now, args.jobId);
      db.prepare(`UPDATE chains SET status = 'dead_lettered', updated_at = ? WHERE id = ?`).run(
        now,
        job.chain_id,
      );
      const r = db
        .prepare(
          `INSERT INTO dead_letters (job_id, chain_id, reason, error, step_log_path, created_at)
           VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
        )
        .get(args.jobId, job.chain_id, args.reason, args.error, args.stepLogPath ?? null, now) as DeadLetterRow;
      return rowToDeadLetter(r);
    })
    .immediate();
}

/** Dead letters, newest first, optionally only those not yet resolved. */
export function listDeadLetters(db: Db, opts: { unresolved?: boolean } = {}): DeadLetter[] {
  const where = opts.unresolved ? 'WHERE resolved_at IS NULL' : '';
  const rows = db
    .prepare(`SELECT * FROM dead_letters ${where} ORDER BY created_at DESC, id DESC`)
    .all() as DeadLetterRow[];
  return rows.map(rowToDeadLetter);
}

/** Unresolved dead letters not yet surfaced by their engine, oldest first (retried by maintenance). */
export function listUnsurfacedDeadLetters(db: Db): DeadLetter[] {
  const rows = db
    .prepare('SELECT * FROM dead_letters WHERE resolved_at IS NULL AND surfaced_at IS NULL ORDER BY id')
    .all() as DeadLetterRow[];
  return rows.map(rowToDeadLetter);
}

/** Records that the engine surfaced dead letter `id` (first success wins). */
export function markDeadLetterSurfaced(db: Db, id: number, now: number): void {
  db.prepare('UPDATE dead_letters SET surfaced_at = ? WHERE id = ? AND surfaced_at IS NULL').run(now, id);
}

/**
 * Re-queue the dead-lettered job in place (the unique (chain_id, type, attempt)
 * index forbids a new row): status queued, error/claim/lease cleared, delivery
 * kept so the next claim gets delivery + 1. `result` is cleared unless the
 * reason was effect_error, so post-processing resumes without rerunning the
 * runner. The chain returns to active. Refuses a resolved dead letter or a
 * chain that is no longer dead_lettered (e.g. cancelled).
 */
export function retryDeadLetter(db: Db, jobId: number, now: number): Job {
  return db
    .transaction((): Job => {
      const dl = findUnresolved(db, jobId);
      if (!dl) throw new Error(`no unresolved dead letter for job ${jobId}`);
      const chain = db.prepare('SELECT status FROM chains WHERE id = ?').get(dl.chain_id) as
        | { status: string }
        | undefined;
      if (!chain || chain.status !== 'dead_lettered') {
        throw new Error(
          `cannot retry job ${jobId}: chain ${dl.chain_id} is ${chain ? chain.status : 'missing'}, not dead_lettered`,
        );
      }
      db.prepare(
        `UPDATE jobs
            SET status = 'queued', error = NULL, claimed_by = NULL, lease_expires_at = NULL,
                result = CASE WHEN ? = 'effect_error' THEN result ELSE NULL END,
                updated_at = ?
          WHERE id = ?`,
      ).run(dl.reason, now, jobId);
      db.prepare(`UPDATE chains SET status = 'active', updated_at = ? WHERE id = ?`).run(now, dl.chain_id);
      db.prepare('UPDATE dead_letters SET resolved_at = ? WHERE id = ?').run(now, dl.id);
      return getJob(db, jobId);
    })
    .immediate();
}

/** Cancel the chain (freeing its subject key) and resolve the dead letter; the job stays failed. */
export function discardDeadLetter(db: Db, jobId: number, now: number): void {
  db.transaction(() => {
    const dl = findUnresolved(db, jobId);
    if (!dl) throw new Error(`no unresolved dead letter for job ${jobId}`);
    db.prepare(`UPDATE chains SET status = 'cancelled', updated_at = ? WHERE id = ?`).run(now, dl.chain_id);
    db.prepare('UPDATE dead_letters SET resolved_at = ? WHERE id = ?').run(now, dl.id);
  }).immediate();
}
