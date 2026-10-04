import { hostname } from 'node:os';
import type Database from 'better-sqlite3';
import { chainEvents, type EventRow } from './events.js';
import { costOf } from './queue.js';
import { isProcessAlive } from './workers.js';

type Db = Database.Database;

export interface JobView {
  id: number;
  type: string;
  attempt: number;
  status: string;
  delivery: number;
  workerId: string | null;
  leaseExpiresAt: number | null;
  /** Milliseconds since the last event of this job (or of its chain when the job has none). */
  sinceLastEventMs: number | null;
  costUsd: number | null;
}

export interface ChainCost {
  jobs: { jobId: number; type: string; attempt: number; costUsd: number | null }[];
  totalUsd: number;
}

interface JobDbRow {
  id: number;
  type: string;
  attempt: number;
  status: string;
  delivery: number;
  claimed_by: string | null;
  lease_expires_at: number | null;
  result: string | null;
  last_at: number | null;
}

/** A chain's jobs, oldest first, with how long each has been in its state. */
export function chainJobViews(db: Db, chainId: number, now: number): JobView[] {
  const chainLast = (db.prepare('SELECT MAX(at) AS at FROM events WHERE chain_id = ?').get(chainId) as { at: number | null }).at;
  const rows = db
    .prepare(
      `SELECT j.id, j.type, j.attempt, j.status, j.delivery, j.claimed_by, j.lease_expires_at, j.result,
              (SELECT MAX(at) FROM events e WHERE e.job_id = j.id) AS last_at
         FROM jobs j WHERE j.chain_id = ? ORDER BY j.id`,
    )
    .all(chainId) as JobDbRow[];
  return rows.map((r) => {
    const last = r.last_at ?? chainLast;
    return {
      id: r.id,
      type: r.type,
      attempt: r.attempt,
      status: r.status,
      delivery: r.delivery,
      workerId: r.status === 'running' ? r.claimed_by : null,
      leaseExpiresAt: r.status === 'running' ? r.lease_expires_at : null,
      sinceLastEventMs: last === null ? null : Math.max(0, now - last),
      costUsd: costOf(r.result) ?? null,
    };
  });
}

/** The cost of every job of a chain that reported one, and their sum. */
export function chainCost(db: Db, chainId: number): ChainCost {
  const rows = db.prepare('SELECT id, type, attempt, result FROM jobs WHERE chain_id = ? ORDER BY id').all(chainId) as {
    id: number;
    type: string;
    attempt: number;
    result: string | null;
  }[];
  const jobs = rows.map((r) => ({ jobId: r.id, type: r.type, attempt: r.attempt, costUsd: costOf(r.result) ?? null }));
  return { jobs, totalUsd: jobs.reduce((sum, j) => sum + (j.costUsd ?? 0), 0) };
}

export interface ChainTimeline {
  chain: { id: number; engine: string; subjectKey: string; status: string; createdAt: number };
  events: EventRow[];
  cost: ChainCost;
}

/** Null when the chain does not exist. */
export function chainTimeline(db: Db, chainId: number): ChainTimeline | null {
  const c = db.prepare('SELECT id, engine, subject_key, status, created_at FROM chains WHERE id = ?').get(chainId) as
    | { id: number; engine: string; subject_key: string; status: string; created_at: number }
    | undefined;
  if (!c) return null;
  return {
    chain: { id: c.id, engine: c.engine, subjectKey: c.subject_key, status: c.status, createdAt: c.created_at },
    events: chainEvents(db, chainId),
    cost: chainCost(db, chainId),
  };
}

export interface WorkerView {
  id: string;
  pid: number;
  host: string;
  /** Null when the worker runs on another host and cannot be probed from here. */
  alive: boolean | null;
  currentJobId: number | null;
  currentDelivery: number | null;
  heartbeatAgeMs: number;
}

export function listWorkerViews(
  db: Db,
  now: number,
  probe: { host?: string; isAlive?: typeof isProcessAlive } = {},
): WorkerView[] {
  const here = probe.host ?? hostname();
  const isAlive = probe.isAlive ?? isProcessAlive;
  const rows = db.prepare('SELECT * FROM workers ORDER BY id').all() as {
    id: string;
    pid: number;
    process_start_time: string | null;
    host: string;
    last_seen_at: number;
    current_job_id: number | null;
    current_delivery: number | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    pid: r.pid,
    host: r.host,
    alive: r.host === here ? isAlive(r.pid, r.process_start_time === null ? 0 : Number(r.process_start_time)) : null,
    currentJobId: r.current_job_id,
    currentDelivery: r.current_delivery,
    heartbeatAgeMs: Math.max(0, now - r.last_seen_at),
  }));
}

/** `45s`, `30m`, `2h`, `7d` to milliseconds; null when malformed. */
export function parseDuration(text: string): number | null {
  const m = /^([0-9]+)([smhd])$/.exec(text);
  if (!m) return null;
  const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 's' | 'm' | 'h' | 'd'];
  return Number(m[1]) * unit;
}

/** `42s`, `5m`, `3h`, `2d`: the largest whole unit. */
export function formatAge(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

export const formatCost = (usd: number): string => `$${usd.toFixed(4)}`;
