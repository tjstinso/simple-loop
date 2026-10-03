import type Database from 'better-sqlite3';
import { DeadLetterStateError, deadLetter } from './dlq.js';
import { requeueJob } from './queue.js';
import {
  groupHasMembers,
  isProcessAlive,
  killProcessGroup,
  liveChildrenFor,
  markChildExited,
} from './workers.js';

export interface ReapReport {
  requeued: number[];
  deadLettered: number[];
  /** Pids and pgids that were signalled. */
  killed: number[];
}

export interface ReapDeps {
  now: number;
  maxDeliveries: number;
  isAlive?: typeof isProcessAlive;
  /** Kills a child's whole process group. Never used for a worker. */
  killGroup?: typeof killProcessGroup;
  /** Kills a single pid (the claiming worker). */
  killPid?: (pid: number) => void;
}

/** SIGKILL one pid. Ignores ESRCH; refuses pid <= 1 and this process's own pid. */
export function killPidDefault(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;
  }
}

/**
 * Kill-before-reclaim: for every running job whose lease has strictly expired,
 * first kill the live children of its current delivery and the claiming worker
 * (by pid only), mark the children exited, and only then requeue the job or
 * dead-letter it once `delivery >= maxDeliveries`. Never signals this process.
 */
export function reapExpired(db: Database.Database, deps: ReapDeps): ReapReport {
  const isAlive = deps.isAlive ?? isProcessAlive;
  const killGroup = deps.killGroup ?? killProcessGroup;
  const killPid = deps.killPid ?? killPidDefault;
  const report: ReapReport = { requeued: [], deadLettered: [], killed: [] };

  const expired = db
    .prepare(
      `SELECT id, delivery, claimed_by FROM jobs
        WHERE status = 'running' AND lease_expires_at < ? ORDER BY id`,
    )
    .all(deps.now) as { id: number; delivery: number; claimed_by: string | null }[];

  for (const job of expired) {
    const children = liveChildrenFor(db, job.id, job.delivery);
    const worker =
      job.claimed_by === null
        ? undefined
        : (db.prepare('SELECT pid, process_start_time FROM workers WHERE id = ?').get(job.claimed_by) as
            | { pid: number; process_start_time: string | null }
            | undefined);

    // 1. Kill before any state change.
    for (const child of children) {
      if (isAlive(child.pid, child.startTime) || groupHasMembers(child.pgid)) {
        killGroup(child.pgid);
        report.killed.push(child.pgid);
      }
    }
    // Worker: by pid only (a shell may share one group across workers), never self.
    if (worker && worker.pid !== process.pid) {
      const startTime = worker.process_start_time === null ? 0 : Number(worker.process_start_time);
      if (isAlive(worker.pid, startTime)) {
        killPid(worker.pid);
        report.killed.push(worker.pid);
      }
    }

    // 2. Mark children exited.
    for (const child of children) markChildExited(db, child.id, null, deps.now);

    // 3. Reclaim, unless the job raced out of this delivery meanwhile.
    const current = db.prepare('SELECT status, delivery FROM jobs WHERE id = ?').get(job.id) as
      | { status: string; delivery: number }
      | undefined;
    if (!current || current.status !== 'running' || current.delivery !== job.delivery) continue;

    if (job.delivery >= deps.maxDeliveries) {
      try {
        deadLetter(
          db,
          {
            jobId: job.id,
            reason: 'max_deliveries',
            error: `job ${job.id} lease expired on delivery ${job.delivery} (max ${deps.maxDeliveries})`,
          },
          deps.now,
        );
        report.deadLettered.push(job.id);
      } catch (e) {
        if (!(e instanceof DeadLetterStateError)) throw e;
      }
    } else if (requeueJob(db, job.id, { delivery: job.delivery })) {
      report.requeued.push(job.id);
    }
  }
  return report;
}
