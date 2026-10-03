import type Database from 'better-sqlite3';
import { DeadLetterStateError, deadLetter } from './dlq.js';
import { requeueJob } from './queue.js';
import {
  groupHasMembers,
  isProcessAlive,
  killProcessGroupNow,
  liveChildrenFor,
  markChildExited,
} from './workers.js';

export interface ReapReport {
  requeued: number[];
  deadLettered: number[];
  /** Pids and pgids that were signalled. */
  killed: number[];
  /** Jobs whose kill or write threw; their state was left untouched. */
  errors: { jobId: number; error: string }[];
}

export interface ReapDeps {
  now: number;
  maxDeliveries: number;
  isAlive?: typeof isProcessAlive;
  /** Kills a child's whole process group (default: synchronous SIGKILL). Never used for a worker. */
  killGroup?: (pgid: number) => void;
  /** True when the process group still has members (default: a real probe). */
  groupProbe?: (pgid: number) => boolean;
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
 * (by pid only, and only while that worker's row still names this job delivery
 * as its current one: a worker that moved on to another job is healthy), mark the children exited, and only then requeue the job or
 * dead-letter it once `delivery >= maxDeliveries`. Never signals this process.
 */
export function reapExpired(db: Database.Database, deps: ReapDeps): ReapReport {
  const isAlive = deps.isAlive ?? isProcessAlive;
  const killGroup = deps.killGroup ?? killProcessGroupNow;
  const groupProbe = deps.groupProbe ?? groupHasMembers;
  const killPid = deps.killPid ?? killPidDefault;
  const report: ReapReport = { requeued: [], deadLettered: [], killed: [], errors: [] };

  const expired = db
    .prepare(
      `SELECT id, delivery, claimed_by FROM jobs
        WHERE status = 'running' AND lease_expires_at < ? ORDER BY id`,
    )
    .all(deps.now) as { id: number; delivery: number; claimed_by: string | null }[];

  const reapOne = (job: { id: number; delivery: number; claimed_by: string | null }): void => {
    // Re-verify against the live row: the snapshot may be stale (heartbeat, finished, reclaimed).
    const live = db
      .prepare('SELECT status, delivery, claimed_by, lease_expires_at FROM jobs WHERE id = ?')
      .get(job.id) as
      | { status: string; delivery: number; claimed_by: string | null; lease_expires_at: number | null }
      | undefined;
    if (
      !live ||
      live.status !== 'running' ||
      live.delivery !== job.delivery ||
      live.claimed_by !== job.claimed_by ||
      live.lease_expires_at === null ||
      live.lease_expires_at >= deps.now
    ) {
      return;
    }
    const children = liveChildrenFor(db, job.id, job.delivery);
    const worker =
      job.claimed_by === null
        ? undefined
        : (db
            .prepare('SELECT pid, process_start_time, current_job_id, current_delivery FROM workers WHERE id = ?')
            .get(job.claimed_by) as
            | { pid: number; process_start_time: string | null; current_job_id: number | null; current_delivery: number | null }
            | undefined);

    // 1. Kill before any state change.
    for (const child of children) {
      if (isAlive(child.pid, child.startTime) || groupProbe(child.pgid)) {
        killGroup(child.pgid);
        report.killed.push(child.pgid);
      }
    }
    // Worker: by pid only (a shell may share one group across workers), never self, and only
    // while it is still on this delivery (after a thrown delivery or lost lease it claims other jobs).
    if (
      worker &&
      worker.pid !== process.pid &&
      worker.current_job_id === job.id &&
      worker.current_delivery === job.delivery
    ) {
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
    if (!current || current.status !== 'running' || current.delivery !== job.delivery) return;

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
  };

  for (const job of expired) {
    try {
      reapOne(job);
    } catch (e) {
      report.errors.push({ jobId: job.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return report;
}
