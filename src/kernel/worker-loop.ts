import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { performance } from 'node:perf_hooks';
import { readProcessStartTime } from '../util/proc.js';
import { processDelivery, type DeliveryOutcome } from './process-delivery.js';
import { cancelChain, listUnsurfacedDeadLetters, markDeadLetterSurfaced } from './dlq.js';
import { recordEvent } from './events.js';
import {
  claimNext,
  recordThrottled,
  completeWaitingChain,
  getChain,
  getJob,
  minAvailableAt,
  recordChainCheck,
  renewLease,
  requeueJob,
  startWaitingChainWork,
  updateWaitingChainState,
} from './queue.js';
import { reapExpired, type ReapDeps } from './reaper.js';
import { pruneHistory } from './retention.js';
import type { ChainStatus, ChainView, Engine, Fence, Job, KernelDeps } from './types.js';
import {
  killProcessGroupNow,
  liveChildrenFor,
  markChildExited,
  ownPgid,
  reapOwnOrphans,
  registerWorker,
  setWorkerJob,
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
  /**
   * How long `stop()`, and the worker after losing a lease, wait for the current delivery to settle
   * before moving on (default 10 s).
   */
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
  /**
   * After a detected suspend or stall the worker skips its reaper for this long, so owners of leases
   * that expired only because everything was frozen can renew them first
   * (default `2 * heartbeatMs`, at least 30 s).
   */
  resumeGraceMs?: number;
  /** Monotonic clock in ms (default `performance.now`), compared with the wall clock to detect a gap. */
  monotonic?: () => number;
}

/** Between two timer ticks `intervalMs` apart, more than `3 * intervalMs` passed: the process was suspended or stalled. */
export function detectGap(previousTickMs: number, nowMs: number, intervalMs: number): boolean {
  return nowMs - previousTickMs > 3 * intervalMs;
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
 * requeue or dead-letter; skipped with `skipReap`, in the grace after a suspend), surface every dead letter not yet surfaced (the
 * reaper's own, and any whose surfacing failed earlier) through its chain's
 * engine, reconcile waiting chains (`reconcileWaiting`), prune aged history, then run every engine's optional `sweep`. Errors are
 * passed to `onError` and never stop the remaining steps or other jobs.
 */
export async function runMaintenance(
  deps: KernelDeps,
  opts: { onError?: ErrorHandler; reap?: ReapOverrides; skipReap?: boolean } = {},
): Promise<void> {
  const onError = opts.onError ?? defaultOnError;
  if (!opts.skipReap) {
    try {
      const report = reapExpired(deps.db, {
        ...opts.reap,
        now: deps.clock(),
        maxDeliveries: deps.config.maxDeliveries,
      });
      for (const e of report.errors) onError(new Error(`reaper: job ${e.jobId}: ${e.error}`));
    } catch (e) {
      onError(e);
    }
  }
  await surfacePending(deps, onError);
  await reconcileWaiting(deps, onError);
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

/**
 * For every `waiting` chain whose engine defines `reconcile`: validates the engine state, asks the
 * engine whether the subject was settled outside the factory and applies the answer. `completed`
 * completes the chain (engine state through `finalState`), `cancelled` cancels it (`cancelChain`,
 * then `afterCancel`); both only if the chain is still `waiting` at the moment of the write, in one
 * transaction, so concurrent workers and a manual `factory cancel` cannot conflict. `afterReconcile`
 * runs last. Each error goes to `onError` and never stops the other chains.
 */
export async function reconcileWaiting(deps: KernelDeps, onError: ErrorHandler = defaultOnError): Promise<void> {
  let ids: number[];
  try {
    ids = (deps.db.prepare(`SELECT id FROM chains WHERE status = 'waiting' ORDER BY id`).all() as { id: number }[]).map(
      (r) => r.id,
    );
  } catch (e) {
    onError(e);
    return;
  }
  for (const id of ids) {
    let engine: Engine<unknown> | undefined;
    /** One small UPDATE after the reconcile call; its failure goes to `onError` and changes nothing else. */
    const check = (expected: ChainStatus, result: string): void => {
      try {
        recordChainCheck(deps.db, id, deps.clock(), expected, result);
      } catch (e) {
        onError(e);
      }
    };
    try {
      const chain = getChain(deps.db, id);
      if (chain.status !== 'waiting') continue;
      engine = deps.engines.get(chain.engine);
      if (!engine.reconcile) continue;
      const parsed = engine.stateSchema.safeParse(chain.engineState);
      if (!parsed.success) throw new Error(`invalid engine state for chain ${chain.id}: ${parsed.error.message}`);
      const view: ChainView<unknown> = {
        id: chain.id,
        engine: chain.engine,
        subjectKey: chain.subjectKey,
        status: chain.status,
        state: parsed.data,
      };
      const result = await engine.reconcile(view);
      if (result.outcome === 'none') {
        check('waiting', result.check ?? 'none');
        continue;
      }
      if (result.outcome === 'update') {
        updateWaitingChainState(deps.db, id, result.engineState, deps.clock());
        check('waiting', 'update');
        continue;
      }
      if (result.outcome === 'new_work') {
        const policy = deps.policies.match(result.job.policyKind, result.job.labels);
        const started = startWaitingChainWork(
          deps.db,
          id,
          result.engineState,
          { type: result.job.type, attempt: result.job.attempt, policyId: policy.id, payload: result.job.payload },
          deps.clock(),
        );
        if (started) check('active', 'new_work');
        continue;
      }
      let applied: boolean;
      let finalView = view;
      if (result.outcome === 'completed') {
        const state = engine.finalState ? engine.finalState(parsed.data) : parsed.data;
        applied = completeWaitingChain(deps.db, id, state, deps.clock());
        finalView = { ...view, status: 'completed', state };
      } else {
        try {
          cancelChain(deps.db, id, deps.clock(), { onlyIfStatus: 'waiting' });
          applied = true;
        } catch (e) {
          // Lost a race (someone else completed or cancelled it): not an error.
          if (getChain(deps.db, id).status === 'waiting') throw e;
          applied = false;
        }
        finalView = { ...view, status: 'cancelled' };
      }
      if (!applied) continue;
      check(finalView.status, result.outcome);
      if (result.outcome === 'cancelled' && engine.afterCancel) {
        try {
          await engine.afterCancel(finalView);
        } catch (e) {
          onError(e);
        }
      }
      if (engine.afterReconcile) {
        try {
          await engine.afterReconcile(finalView, result);
        } catch (e) {
          onError(e);
        }
      }
    } catch (e) {
      check('waiting', checkErrorText(e, engine));
      onError(e);
    }
  }
}

/** `error: <message>` on one line, redacted by the chain's engine (the cap is applied when it is stored). */
function checkErrorText(e: unknown, engine: Engine<unknown> | undefined): string {
  let text = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').trim();
  try {
    text = engine?.redact?.(text) ?? text;
  } catch {
    text = '[unavailable]';
  }
  return `error: ${text}`;
}

/**
 * Surfaces every unresolved, not yet surfaced dead letter through its chain's engine (the reaper has
 * no engine, and a delivery's own surfacing may have failed) and marks each one surfaced on success.
 * A dead letter whose chain is no longer dead_lettered is skipped. Each error goes to `onError`
 * (with the job when known) and the row stays unsurfaced for the next pass.
 */
async function surfacePending(deps: KernelDeps, onError: ErrorHandler): Promise<void> {
  let pending;
  try {
    pending = listUnsurfacedDeadLetters(deps.db);
  } catch (e) {
    onError(e);
    return;
  }
  for (const dl of pending) {
    let job: Job | undefined;
    try {
      job = getJob(deps.db, dl.jobId);
      const chain = getChain(deps.db, dl.chainId);
      if (chain.status !== 'dead_lettered') continue;
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
      markDeadLetterSurfaced(deps.db, dl.id, deps.clock());
    } catch (e) {
      onError(e, job);
    }
  }
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
  /** Resolves 'timeout' stopTimeoutMs after the lease was lost (bounds the wait for a runner ignoring the abort). */
  abandoned: Promise<'timeout'>;
  abandonTimer: ReturnType<typeof setTimeout> | undefined;
  /** Renews the lease now (see `runJob`); `force` ignores the local deadline. */
  beat: ((force: boolean) => void) | undefined;
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

  const monotonic = opts.monotonic ?? (() => performance.now());
  const resumeGraceMs = opts.resumeGraceMs ?? Math.max(2 * config.heartbeatMs, 30_000);
  let lastWall = clock();
  let lastMono = monotonic();
  /** The reaper stays off until then (set by a detected gap). */
  let reapSkipUntil = 0;

  /**
   * Called first by every timer tick. If more than three intervals passed since the previous tick on
   * the wall clock or on the monotonic clock (which stops while some systems are suspended), the
   * machine was suspended or the process stalled: renew the lease of the running job before anything
   * else, record `worker.resumed` (once per gap, as the tick times are updated here) and keep this
   * worker's reaper off for the grace period so lease owners can renew before any peer acts.
   */
  const checkGap = (): void => {
    const wall = clock();
    const mono = monotonic();
    const wallGap = wall - lastWall;
    const monoGap = mono - lastMono;
    const gapped = detectGap(lastWall, wall, config.heartbeatMs) || detectGap(lastMono, mono, config.heartbeatMs);
    lastWall = wall;
    lastMono = mono;
    if (!gapped || stopping) return;
    const d = current;
    d?.beat?.(true);
    reapSkipUntil = wall + resumeGraceMs;
    try {
      recordEvent(db, {
        at: wall,
        chainId: d?.job.chainId ?? 0,
        jobId: d?.job.id ?? null,
        delivery: d?.job.delivery ?? null,
        kind: 'worker.resumed',
        engine: 'kernel',
        detail: { worker: id, gapMs: Math.max(wallGap, monoGap), graceMs: resumeGraceMs },
      });
    } catch (e) {
      report(e, d?.job);
    }
  };

  const gapTimer = setInterval(checkGap, config.heartbeatMs);

  const maintenanceTimer = setInterval(() => {
    checkGap();
    if (stopping || maintenanceRun) return;
    maintenanceRun = runMaintenance(deps, {
      onError: report,
      reap: { killGroup, ...opts.reap },
      skipReap: clock() < reapSkipUntil,
    })
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

  const clearCurrent = (): void => {
    try {
      setWorkerJob(db, id, null, null);
    } catch (e) {
      report(e);
    }
  };

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
    clearTimeout(d.abandonTimer);
    // Finished or abandoned: the reaper must no longer treat this worker as the delivery's owner.
    clearCurrent();
    if (d.leaseLost || d.stopRequested) killChildren(d);
    // Hand an interrupted delivery straight back, unless the lease is no
    // longer ours (then it belongs to its new owner or the reaper). A thrown
    // delivery is left running for the reaper; nothing else is recorded.
    if (d.stopRequested && !d.leaseLost && (outcome === 'aborted' || outcome === 'timeout')) {
      try {
        requeueJob(db, d.job.id, { delivery: d.job.delivery, now: clock(), why: 'worker stopping' });
      } catch (e) {
        report(e, d.job);
      }
    }
  };

  const runJob = async (job: Job): Promise<void> => {
    const fence: Fence = { jobId: job.id, delivery: job.delivery };
    let leaseExpiresAt = job.leaseExpiresAt ?? clock() + config.leaseMs;
    let abandon!: () => void;
    const d: Delivery = {
      job,
      ac: new AbortController(),
      heartbeat: undefined,
      leaseLost: false,
      stopRequested: false,
      finalized: false,
      settled: undefined as unknown as Promise<Settled>,
      abandoned: new Promise<'timeout'>((r) => (abandon = () => r('timeout'))),
      abandonTimer: undefined,
      beat: undefined,
    };

    const loseLease = (): void => {
      d.leaseLost = true;
      try {
        recordEvent(db, {
          at: clock(),
          chainId: job.chainId,
          jobId: job.id,
          delivery: job.delivery,
          kind: 'job.lease_lost',
          engine: 'kernel',
          detail: { worker: id },
        });
      } catch (e) {
        report(e, job);
      }
      stopHeartbeat(d);
      clearCurrent();
      d.ac.abort(new Error(`lease lost for job ${job.id} delivery ${job.delivery}`));
      // Like stop(): do not wait forever for a runner that ignores the abort.
      d.abandonTimer = setTimeout(abandon, stopTimeoutMs);
    };

    /**
     * Renew the lease. `force` (right after a detected suspend) renews although the local deadline
     * passed, as long as the database still names this delivery as the owner: the renewal itself is
     * fenced, so a job that a peer already reclaimed is lost, not resurrected.
     */
    d.beat = (force) => {
      if (d.leaseLost || d.finalized) return;
      const now = clock();
      // Suspended or stalled past our own lease: never renew an expired lease (unless forced).
      if (!force && now >= leaseExpiresAt) return loseLease();
      try {
        if (renewLease(db, fence, now, config.leaseMs)) leaseExpiresAt = now + config.leaseMs;
        else loseLease();
      } catch (e) {
        // E.g. SQLITE_BUSY: retry on the next tick; the local deadline bounds this.
        report(e, job);
      }
      try {
        touchWorker(db, id, now);
      } catch (e) {
        report(e, job);
      }
    };
    d.heartbeat = setInterval(() => {
      checkGap();
      d.beat?.(false);
    }, config.heartbeatMs);

    current = d;
    d.settled = (async (): Promise<Settled> => {
      try {
        return await processDelivery(deps, job, id, d.ac.signal);
      } catch (e) {
        // Stop heartbeating at once so the lease expires and the reaper redelivers; this worker
        // will claim other jobs, so it is no longer this delivery's owner.
        stopHeartbeat(d);
        clearCurrent();
        report(e, job);
        return 'threw';
      }
    })();
    try {
      finalize(d, await Promise.race([d.settled, d.abandoned]));
    } finally {
      if (current === d) current = undefined;
    }
  };

  const loop = async (): Promise<void> => {
    await Promise.resolve(); // return the Worker before the first claim
    while (!stopping) {
      let job: Job | null = null;
      try {
        job = claimNext(db, id, clock(), config.leaseMs, config.maxConcurrentJobs);
        if (!job && config.maxConcurrentJobs !== undefined) recordThrottled(db, clock(), config.maxConcurrentJobs);
      } catch (e) {
        report(e);
      }
      if (job) {
        try {
          setWorkerJob(db, id, job.id, job.delivery);
        } catch (e) {
          report(e, job);
        }
        await runJob(job);
        continue;
      }
      let sleepMs = pollMs;
      try {
        const earliest = minAvailableAt(db, clock());
        if (earliest !== null) {
          sleepMs = Math.min(pollMs, Math.max(0, earliest - clock()));
        }
      } catch (e) {
        report(e);
      }
      await sleep(sleepMs);
    }
  };
  void loop().catch((e) => report(e));

  const doStop = async (): Promise<void> => {
    stopping = true;
    clearInterval(maintenanceTimer);
    clearInterval(gapTimer);
    wake?.();
    const d = current;
    if (d) {
      d.stopRequested = true;
      d.ac.abort(new Error('worker stopping'));
      finalize(d, await withTimeout(d.settled, stopTimeoutMs));
    }
    if (maintenanceRun) await withTimeout(maintenanceRun, stopTimeoutMs);
    clearCurrent();
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
