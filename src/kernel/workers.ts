import { readFileSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { readProcessStartTime } from '../util/proc.js';

export interface ChildRow {
  id: number;
  workerId: string;
  jobId: number;
  delivery: number;
  pid: number;
  pgid: number;
  /** Clock ticks since boot (0 = unknown). */
  startTime: number;
  startedAt: number;
  exitedAt: number | null;
  exitCode: number | null;
}

interface ChildDbRow {
  id: number;
  worker_id: string;
  job_id: number;
  delivery: number;
  pid: number;
  pgid: number;
  process_start_time: string | null;
  started_at: number;
  exited_at: number | null;
  exit_code: number | null;
}

function toChildRow(r: ChildDbRow): ChildRow {
  return {
    id: r.id,
    workerId: r.worker_id,
    jobId: r.job_id,
    delivery: r.delivery,
    pid: r.pid,
    pgid: r.pgid,
    startTime: r.process_start_time === null ? 0 : Number(r.process_start_time),
    startedAt: r.started_at,
    exitedAt: r.exited_at,
    exitCode: r.exit_code,
  };
}

export function registerWorker(
  db: Database.Database,
  args: { id: string; pid: number; pgid: number; startTime: number; host: string },
  now: number,
): void {
  db.prepare(
    `INSERT INTO workers (id, pid, pgid, process_start_time, host, started_at, last_seen_at)
     VALUES (@id, @pid, @pgid, @start, @host, @now, @now)
     ON CONFLICT(id) DO UPDATE SET
       pid = excluded.pid, pgid = excluded.pgid,
       process_start_time = excluded.process_start_time, host = excluded.host,
       started_at = excluded.started_at, last_seen_at = excluded.last_seen_at`,
  ).run({
    id: args.id,
    pid: args.pid,
    pgid: args.pgid,
    start: String(args.startTime),
    host: args.host,
    now,
  });
}

export function touchWorker(db: Database.Database, id: string, now: number): void {
  db.prepare('UPDATE workers SET last_seen_at = ? WHERE id = ?').run(now, id);
}

export function recordChild(
  db: Database.Database,
  args: { workerId: string; jobId: number; delivery: number; pid: number; pgid: number; startTime: number },
  now: number,
): number {
  const info = db
    .prepare(
      `INSERT INTO child_processes (worker_id, job_id, delivery, pid, pgid, process_start_time, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(args.workerId, args.jobId, args.delivery, args.pid, args.pgid, String(args.startTime), now);
  return Number(info.lastInsertRowid);
}

export function markChildExited(
  db: Database.Database,
  childId: number,
  code: number | null,
  now: number,
): void {
  db.prepare('UPDATE child_processes SET exited_at = ?, exit_code = ? WHERE id = ?').run(now, code, childId);
}

export function liveChildrenFor(db: Database.Database, jobId: number, delivery: number): ChildRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM child_processes
       WHERE job_id = ? AND delivery = ? AND exited_at IS NULL ORDER BY id`,
    )
    .all(jobId, delivery) as ChildDbRow[];
  return rows.map(toChildRow);
}

/**
 * True when `pid` exists and is the same process instance that was recorded.
 * A differing start time means the pid was reused. `startTime` 0 (unknown)
 * falls back to a plain existence check.
 */
export function isProcessAlive(pid: number, startTime: number): boolean {
  if (startTime !== 0) {
    const current = readProcessStartTime(pid);
    return current !== null && current === startTime;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** This process's own process group id (field 5 of /proc/self/stat), or null. */
export function ownPgid(): number | null {
  try {
    const stat = readFileSync('/proc/self/stat', 'utf8');
    const n = Number(stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[2]);
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * A pgid is safe to signal only if it is a real group id: not 0 (own group),
 * 1 (kill(-1) hits everything), negative, non-integer, or the caller's own group.
 */
function isSignalablePgid(pgid: number): boolean {
  return Number.isInteger(pgid) && pgid > 1 && pgid !== ownPgid();
}

/** SIGTERM the whole process group, then SIGKILL after `graceMs`. Refuses unsafe pgids. */
export function killProcessGroup(pgid: number, graceMs = 2000): void {
  if (!isSignalablePgid(pgid)) return;
  const signal = (sig: NodeJS.Signals): void => {
    try {
      process.kill(-pgid, sig);
    } catch {
      /* ESRCH: group already gone */
    }
  };
  signal('SIGTERM');
  setTimeout(() => signal('SIGKILL'), graceMs).unref();
}

/** Synchronous SIGKILL to the whole process group. Same pgid guard as killProcessGroup; ignores ESRCH. */
export function killProcessGroupNow(pgid: number): void {
  if (!isSignalablePgid(pgid)) return;
  try {
    process.kill(-pgid, 'SIGKILL');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;
  }
}

export function groupHasMembers(pgid: number): boolean {
  if (!isSignalablePgid(pgid)) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false; // ESRCH: empty; EPERM: cannot signal it anyway
  }
}

/**
 * Startup sweep: kills this worker id's still-running children (left by a
 * previous incarnation) and marks their rows exited. Returns reaped row ids.
 */
export function reapOwnOrphans(db: Database.Database, workerId: string, now: number): number[] {
  const rows = db
    .prepare('SELECT * FROM child_processes WHERE worker_id = ? AND exited_at IS NULL ORDER BY id')
    .all(workerId) as ChildDbRow[];
  const reaped: number[] = [];
  for (const r of rows.map(toChildRow)) {
    // Kill when the leader is alive, or when the leader is gone but group
    // members survive. Residual risk (accepted): an emptied, recycled pgid
    // number could be probed/signalled.
    if (isProcessAlive(r.pid, r.startTime) || groupHasMembers(r.pgid)) killProcessGroup(r.pgid);
    markChildExited(db, r.id, null, now);
    reaped.push(r.id);
  }
  return reaped;
}
