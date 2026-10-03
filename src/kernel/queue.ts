import type Database from 'better-sqlite3';
import type { Chain, ChainStatus, Job, JobStatus, ResolvedNewJob } from './types.js';

export class DuplicateChainError extends Error {
  constructor(message = 'an open chain already exists for this subject') {
    super(message);
    this.name = 'DuplicateChainError';
  }
}

type Db = Database.Database;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function rowToChain(r: any): Chain {
  return {
    id: r.id,
    engine: r.engine,
    subjectKey: r.subject_key,
    status: r.status as ChainStatus,
    engineState: JSON.parse(r.engine_state),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function rowToJob(r: any): Job {
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
  const r = db.prepare('SELECT * FROM chains WHERE id = ?').get(id);
  if (!r) throw new Error(`chain ${id} not found`);
  return rowToChain(r);
}

export function getJob(db: Db, id: number): Job {
  const r = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  if (!r) throw new Error(`job ${id} not found`);
  return rowToJob(r);
}

export function listJobsForChain(db: Db, chainId: number): Job[] {
  return db.prepare('SELECT * FROM jobs WHERE chain_id = ? ORDER BY id').all(chainId).map(rowToJob);
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
