import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { readProcessStartTime } from '../util/proc.js';
import { processDelivery, type DeliveryOutcome } from './process-delivery.js';
import { listDeadLetters } from './dlq.js';
import { claimNext, getChain, getJob, renewLease, requeueJob } from './queue.js';
import { reapExpired, type ReapDeps } from './reaper.js';
import { pruneHistory } from './retention.js';
import type { ChainView, Fence, Job, KernelDeps } from './types.js';
import {
  killProcessGroupNow,
  liveChildrenFor,
  markChildExited,
  ownPgid,
  reapOwnOrphans,
  registerWorker,
  touchWorker,
} from './workers.js';

export type ErrorHandler = (err: unknown, job?: Job) => void;

/** Reaper overrides other than the values the kernel supplies itself. */
export type ReapOverrides = Partial<Omit<ReapDeps, 'now' | 'maxDeliveries'>>;

export interface WorkerOptions {
  /** Worker id (default: `<host>:<pid>:<random>`). */
  id?: string;
  /** Delay between empty claim attempts (default 1000 ms). Interrupted by `stop()`. */
  pollMs?: number;
  /** Interval of `runMaintenance` (default 60 s). */
  maintenanceMs?: number;
  /** How long `stop()` waits for the current delivery to settle (default 10 s). */
  stopTimeoutMs?: number;
  /** Receives delivery errors (with the job) and maintenance errors (without). Default: console.error. */
  onError?: ErrorHandler;
  /**
   * Kills a child's process group (default: synchronous SIGKILL). Used by the
   * stop / lease-loss safety net and passed to the reaper.
   */
  killGroup?: (pgid: number) => void;
  /** Further reaper overrides (liveness probes, worker kill). */
  reap?: ReapOverrides;
}

export interface Worker {
  id: string;
  /** Resolves once the worker has stopped. */
  done: Promise<void>;
  /** Idempotent: every call returns the same promise. */
  stop(): Promise<void>;
}

const defaultOnError: ErrorHandler = (err, job) => {
  console.error(job ? `worker: job ${job.id} delivery ${job.delivery}:` : 'worker:', err);
};

/**
 * Periodic kernel maintenance: reap expired leases (kill before reclaim,
 * requeue or dead-letter), surface each job the reaper dead-lettered through
 * its chain's engine, prune aged history, then run every engine's optional `sweep`. Errors are
 * passed to `onError` and never stop the remaining steps or other jobs.
 */
export async function runMaintenance(
  deps: KernelDeps,
  opts: { onError?: ErrorHandler; reap?: ReapOverrides } = {},
): Promise<void> {
  const onError = opts.onError ?? defaultOnError;
  let deadLettered: number[] = [];
  try {
    const report = reapExpired(deps.db, {
      ...opts.reap,
      now: deps.clock(),
      maxDeliveries: deps.config.maxDeliveries,
    });
    deadLettered = report.deadLettered;
    for (const e of report.errors) onError(new Error(`reaper: job ${e.jobId}: ${e.error}`));
  } catch (e) {
    onError(e);
  }
  for (const jobId of deadLettered) {
    let job: Job | undefined;
    try {
      job = getJob(deps.db, jobId);
      await surfaceReaped(deps, job);
    } catch (e) {
      onError(e, job);
    }
  }
  try {
    pruneHistory(deps.db, deps.clock(), deps.config.historyRetentionDays ?? 30);
  } catch (e) {
    onError(e);
  }
  for (const id of deps.engines.ids()) {
    const engine = deps.engines.get(id);
    if (!engine.sweep) continue;
    try {
      await engine.sweep(deps.clock());
    } catch (e) {
      onError(e);
    }
  }
}

/** Surfaces a reaper dead letter through the chain's engine (the reaper itself has no engine). */
async function surfaceReaped(deps: KernelDeps, job: Job): Promise<void> {
  const dl = listDeadLetters(deps.db, { unresolved: true }).find((d) => d.jobId === job.id);
  if (!dl) return; // already retried or discarded
  const chain = getChain(deps.db, job.chainId);
  const engine = deps.engines.get(chain.engine);
  const parsed = engine.stateSchema.safeParse(chain.engineState);
  if (!parsed.success) throw new Error(`invalid engine state for chain ${chain.id}: ${parsed.error.message}`);
  const view: ChainView<unknown> = {
    id: chain.id,
    engine: chain.engine,
    subjectKey: chain.subjectKey,
    status: chain.status,
    state: parsed.data,
  };
  await engine.surfaceDeadLetter(view, dl);
}

type Settled = DeliveryOutcome | 'threw' | 'timeout';

interface Delivery {
  job: Job;
  ac: AbortController;
  heartbeat: ReturnType<typeof setInterval> | undefined;
  /** The lease renewal failed or the local deadline passed: the job is no longer ours. */
  leaseLost: boolean;
  stopRequested: boolean;
  finalized: boolean;
  settled: Promise<Settled>;
}

/** Resolves with `p`'s value, or 'timeout' after `ms`. The timer is always cleared. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<'timeout'>((r) => {
    timer = setTimeout(() => r('timeout'), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

/**
 * Start a worker (spec section 5): register, reap this id's orphans, then
 * claim and process jobs one at a time until `stop()`. Each delivery gets its
 * own AbortController and a heartbeat that renews the lease every
 * `heartbeatMs`; losing the lease aborts the run (self-fencing).
 */
export function startWorker(deps: KernelDeps, opts: WorkerOptions = {}): Worker {
  const { db, clock, config } = deps;
  const id = opts.id ?? `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  const pollMs = opts.pollMs ?? 1000;
  const maintenanceMs = opts.maintenanceMs ?? 60_000;
  const stopTimeoutMs = opts.stopTimeoutMs ?? 10_000;
  const killGroup = opts.killGroup ?? killProcessGroupNow;
  const onError = opts.onError ?? defaultOnError;
  const report = (err: unknown, job?: Job): void => {
    try {
      onError(err, job);
    } catch {
      // An error handler must never take the worker down.
    }
  };

  registerWorker(
    db,
    {
      id,
      pid: process.pid,
      pgid: ownPgid() ?? process.pid,
      startTime: readProcessStartTime(process.pid) ?? 0,
      host: hostname(),
    },
    clock(),
  );
  try {
    reapOwnOrphans(db, id, clock());
  } catch (e) {
    report(e);
  }

  let stopping = false;
  let stopPromise: Promise<void> | undefined;
  let current: Delivery | undefined;
  let wake: (() => void) | undefined;
  let maintenanceRun: Promise<void> | undefined;
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));

  const maintenanceTimer = setInterval(() => {
    if (stopping || maintenanceRun) return;
    maintenanceRun = runMaintenance(deps, { onError: report, reap: { killGroup, ...opts.reap } })
      .catch((e) => report(e))
      .finally(() => {
        maintenanceRun = undefined;
      });
  }, maintenanceMs);

  /** Interruptible poll delay: `stop()` calls `wake`. */
  const sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        wake = undefined;
        resolve();
      }, ms);
      wake = () => {
        clearTimeout(timer);
        wake = undefined;
        resolve();
      };
    });

  const stopHeartbeat = (d: Delivery): void => {
    if (d.heartbeat !== undefined) clearInterval(d.heartbeat);
    d.heartbeat = undefined;
  };

  /** Safety net: kill whatever children of this delivery are still recorded live. */
  const killChildren = (d: Delivery): void => {
    try {
      for (const child of liveChildrenFor(db, d.job.id, d.job.delivery)) {
        try {
          killGroup(child.pgid);
        } catch (e) {
          report(e, d.job);
          continue; // leave the row live so the reaper retries
        }
        markChildExited(db, child.id, null, clock());
      }
    } catch (e) {
      report(e, d.job);
    }
  };

  /** Runs once per delivery, from whichever of the delivery or `stop()` gets there first. */
  const finalize = (d: Delivery, outcome: Settled): void => {
    if (d.finalized) return;
    d.finalized = true;
    stopHeartbeat(d);
    if (d.leaseLost || d.stopRequested) killChildren(d);
    // Hand an interrupted delivery straight back, unless the lease is no
    // longer ours (then it belongs to its new owner or the reaper). A thrown
    // delivery is left running for the reaper; nothing else is recorded.
    if (d.stopRequested && !d.leaseLost && (outcome === 'aborted' || outcome === 'timeout')) {
      try {
        requeueJob(db, d.job.id, { delivery: d.job.delivery });
      } catch (e) {
        report(e, d.job);
      }
    }
  };

  const runJob = async (job: Job): Promise<void> => {
    const fence: Fence = { jobId: job.id, delivery: job.delivery };
    let leaseExpiresAt = job.leaseExpiresAt ?? clock() + config.leaseMs;
    const d: Delivery = {
      job,
      ac: new AbortController(),
      heartbeat: undefined,
      leaseLost: false,
      stopRequested: false,
      finalized: false,
      settled: undefined as unknown as Promise<Settled>,
    };

    const loseLease = (): void => {
      d.leaseLost = true;
      stopHeartbeat(d);
      d.ac.abort(new Error(`lease lost for job ${job.id} delivery ${job.delivery}`));
    };

    d.heartbeat = setInterval(() => {
      if (d.leaseLost || d.finalized) return;
      try {
        touchWorker(db, id, clock());
      } catch (e) {
        report(e, job);
      }
      const now = clock();
      // Suspended or stalled past our own lease: never renew an expired lease.
      if (now >= leaseExpiresAt) return loseLease();
      let renewed: boolean;
      try {
        renewed = renewLease(db, fence, now, config.leaseMs);
      } catch (e) {
        // E.g. SQLITE_BUSY: retry on the next tick; the local deadline bounds this.
        report(e, job);
        return;
      }
      if (renewed) leaseExpiresAt = now + config.leaseMs;
      else loseLease();
    }, config.heartbeatMs);

    current = d;
    d.settled = (async (): Promise<Settled> => {
      try {
        return await processDelivery(deps, job, id, d.ac.signal);
      } catch (e) {
        // Stop heartbeating at once so the lease expires and the reaper redelivers.
        stopHeartbeat(d);
        report(e, job);
        return 'threw';
      }
    })();
    try {
      finalize(d, await d.settled);
    } finally {
      if (current === d) current = undefined;
    }
  };

  const loop = async (): Promise<void> => {
    await Promise.resolve(); // return the Worker before the first claim
    while (!stopping) {
      let job: Job | null = null;
      try {
        job = claimNext(db, id, clock(), config.leaseMs);
      } catch (e) {
        report(e);
      }
      if (job) {
        await runJob(job);
        continue;
      }
      await sleep(pollMs);
    }
  };
  void loop().catch((e) => report(e));

  const doStop = async (): Promise<void> => {
    stopping = true;
    clearInterval(maintenanceTimer);
    wake?.();
    const d = current;
    if (d) {
      d.stopRequested = true;
      d.ac.abort(new Error('worker stopping'));
      finalize(d, await withTimeout(d.settled, stopTimeoutMs));
    }
    if (maintenanceRun) await withTimeout(maintenanceRun, stopTimeoutMs);
    resolveDone();
  };

  return {
    id,
    done,
    stop(): Promise<void> {
      stopPromise ??= doStop();
      return stopPromise;
    },
  };
}
