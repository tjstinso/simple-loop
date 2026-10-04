import type Database from 'better-sqlite3';
import { recordEvent } from './events.js';
import { getChain, getJob } from './queue.js';
import type { Chain, ChainStatus, DeadLetter, DeadLetterReason, Job } from './types.js';

type Db = Database.Database;

interface DeadLetterRow {
  id: number;
  job_id: number;
  chain_id: number;
  reason: string;
  error: string;
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
  args: { jobId: number; reason: DeadLetterReason; error: string },
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
          `INSERT INTO dead_letters (job_id, chain_id, reason, error, created_at)
           VALUES (?, ?, ?, ?, ?) RETURNING *`,
        )
        .get(args.jobId, job.chain_id, args.reason, args.error, now) as DeadLetterRow;
      recordEvent(db, {
        at: now,
        chainId: job.chain_id,
        jobId: args.jobId,
        kind: 'job.dead_lettered',
        engine: 'kernel',
        detail: { reason: args.reason },
      });
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
      recordEvent(db, { at: now, chainId: dl.chain_id, jobId, kind: 'dead_letter.retried', engine: 'kernel', detail: { reason: dl.reason } });
      return getJob(db, jobId);
    })
    .immediate();
}

/**
 * Cancel the chain (freeing its subject key) and resolve the dead letter; the job stays failed.
 * Returns the failed job (for the engine's `afterCancel` hook).
 */
export function discardDeadLetter(db: Db, jobId: number, now: number): Job {
  return db
    .transaction((): Job => {
      const dl = findUnresolved(db, jobId);
      if (!dl) throw new Error(`no unresolved dead letter for job ${jobId}`);
      db.prepare(`UPDATE chains SET status = 'cancelled', updated_at = ? WHERE id = ?`).run(now, dl.chain_id);
      db.prepare('UPDATE dead_letters SET resolved_at = ? WHERE id = ?').run(now, dl.id);
      recordEvent(db, { at: now, chainId: dl.chain_id, jobId, kind: 'dead_letter.discarded', engine: 'kernel', detail: { reason: dl.reason } });
      recordEvent(db, { at: now, chainId: dl.chain_id, kind: 'chain.cancelled', engine: 'kernel', detail: { by: 'discard' } });
      return getJob(db, jobId);
    })
    .immediate();
}

/**
 * End a chain by hand (for example a `waiting` chain whose PR a human merged or closed), in one
 * transaction: the chain becomes `cancelled` (freeing its subject key), its queued jobs `cancelled`,
 * and its unresolved dead letters resolved. Refuses (throws, writes nothing) an unknown chain, a
 * chain that is already completed or cancelled, and a chain with a `running` job (stop its worker or
 * wait for the delivery to finish first). With `onlyIfStatus` it also refuses a chain in any other status. Returns the cancelled chain.
 */
export function cancelChain(db: Db, chainId: number, now: number, opts: { onlyIfStatus?: ChainStatus } = {}): Chain {
  return db
    .transaction((): Chain => {
      const chain = db.prepare('SELECT status FROM chains WHERE id = ?').get(chainId) as { status: string } | undefined;
      if (!chain) throw new Error(`chain ${chainId} not found`);
      if (opts.onlyIfStatus !== undefined && chain.status !== opts.onlyIfStatus) {
        throw new Error(`cannot cancel chain ${chainId}: it is ${chain.status}, not ${opts.onlyIfStatus}`);
      }
      if (chain.status === 'completed' || chain.status === 'cancelled') {
        throw new Error(`cannot cancel chain ${chainId}: it is ${chain.status}`);
      }
      const running = db
        .prepare(`SELECT id FROM jobs WHERE chain_id = ? AND status = 'running' ORDER BY id LIMIT 1`)
        .get(chainId) as { id: number } | undefined;
      if (running) {
        throw new Error(`cannot cancel chain ${chainId}: job ${running.id} is running; stop its worker or wait for it to finish`);
      }
      db.prepare(`UPDATE jobs SET status = 'cancelled', updated_at = ? WHERE chain_id = ? AND status = 'queued'`).run(now, chainId);
      db.prepare(`UPDATE chains SET status = 'cancelled', updated_at = ? WHERE id = ?`).run(now, chainId);
      db.prepare('UPDATE dead_letters SET resolved_at = ? WHERE chain_id = ? AND resolved_at IS NULL').run(now, chainId);
      recordEvent(db, { at: now, chainId, kind: 'chain.cancelled', engine: 'kernel', detail: { from: chain.status } });
      return getChain(db, chainId);
    })
    .immediate();
}
