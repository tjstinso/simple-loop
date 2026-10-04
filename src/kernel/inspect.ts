import { hostname } from 'node:os';
import type Database from 'better-sqlite3';
import { chainEvents, type EventRow } from './events.js';
import { costOf } from './queue.js';

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
  /** A queued job waiting for a retry after a transient failure is not claimable before this time. */
  availableAt: number | null;
  /** Retries scheduled after transient failures. */
  transientRetries: number;
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
  available_at: number | null;
  transient_retries: number;
  last_at: number | null;
}

/** A chain's jobs, oldest first, with how long each has been in its state. */
export function chainJobViews(db: Db, chainId: number, now: number): JobView[] {
  const chainLast = (db.prepare('SELECT MAX(at) AS at FROM events WHERE chain_id = ?').get(chainId) as { at: number | null }).at;
  const rows = db
    .prepare(
      `SELECT j.id, j.type, j.attempt, j.status, j.delivery, j.claimed_by, j.lease_expires_at, j.result, j.available_at, j.transient_retries,
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
      availableAt: r.available_at,
      transientRetries: r.transient_retries,
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
  chain: {
    id: number;
    engine: string;
    subjectKey: string;
    status: string;
    createdAt: number;
    lastCheckedAt: number | null;
    lastCheckResult: string | null;
  };
  events: EventRow[];
  cost: ChainCost;
}

/** Null when the chain does not exist. */
export function chainTimeline(db: Db, chainId: number): ChainTimeline | null {
  const c = db
    .prepare('SELECT id, engine, subject_key, status, created_at, last_checked_at, last_check_result FROM chains WHERE id = ?')
    .get(chainId) as
    | {
        id: number;
        engine: string;
        subject_key: string;
        status: string;
        created_at: number;
        last_checked_at: number | null;
        last_check_result: string | null;
      }
    | undefined;
  if (!c) return null;
  return {
    chain: {
      id: c.id,
      engine: c.engine,
      subjectKey: c.subject_key,
      status: c.status,
      createdAt: c.created_at,
      lastCheckedAt: c.last_checked_at,
      lastCheckResult: c.last_check_result,
    },
    events: chainEvents(db, chainId),
    cost: chainCost(db, chainId),
  };
}

/** The kernel's heartbeat interval (see the runtime); a worker on another host is alive within twice this. */
export const HEARTBEAT_MS = 30_000;

/** True when a process with this id exists; a permission error means it exists but is not ours. */
function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface LivenessProbe {
  /** This host's name (default: the machine's). */
  host?: string;
  heartbeatMs?: number;
  pidExists?: (pid: number) => boolean;
}

/**
 * The one rule for worker liveness. On this host a worker is alive while its process exists, however
 * long it has been idle (an idle worker stamps no heartbeat). A worker on another host cannot be
 * probed, so it is alive while its heartbeat is younger than twice the heartbeat interval.
 */
export function isWorkerAlive(
  w: { pid: number; host: string; last_seen_at: number },
  now: number,
  probe: LivenessProbe = {},
): boolean {
  if (w.host === (probe.host ?? hostname())) return (probe.pidExists ?? pidExists)(w.pid);
  return now - w.last_seen_at < 2 * (probe.heartbeatMs ?? HEARTBEAT_MS);
}

export interface WorkerView {
  id: string;
  pid: number;
  host: string;
  alive: boolean;
  currentJobId: number | null;
  currentDelivery: number | null;
  heartbeatAgeMs: number;
}

export function listWorkerViews(db: Db, now: number, probe: LivenessProbe = {}): WorkerView[] {
  const rows = db.prepare('SELECT * FROM workers ORDER BY id').all() as {
    id: string;
    pid: number;
    host: string;
    last_seen_at: number;
    current_job_id: number | null;
    current_delivery: number | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    pid: r.pid,
    host: r.host,
    alive: isWorkerAlive(r, now, probe),
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

/** `last checked: 20s ago (none)`, or `never checked` when the maintenance pass has not looked yet. */
export function formatLastCheck(at: number | null, result: string | null, now: number): string {
  if (at === null) return 'never checked';
  return `last checked: ${formatAge(Math.max(0, now - at))} ago${result === null ? '' : ` (${result})`}`;
}

export const formatCost = (usd: number): string => `$${usd.toFixed(4)}`;

/**
 * A job's status as shown to people: a queued job waiting for its retry delay after a transient
 * failure reads `retrying (attempt n, in <time>)` (n = retries scheduled so far) instead of `queued`.
 */
export function jobStateLabel(
  job: { status: string; availableAt: number | null; transientRetries: number },
  now: number,
): string {
  if (job.status === 'queued' && job.availableAt !== null && job.availableAt > now) {
    return `retrying (attempt ${job.transientRetries}, in ${formatAge(job.availableAt - now)})`;
  }
  return job.status;
}
