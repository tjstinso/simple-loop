import type Database from 'better-sqlite3';
import type { RunHooks, RunInput, Workspace } from '../runner/types.js';
import { DeadLetterStateError, deadLetter, markDeadLetterSurfaced } from './dlq.js';
import { commitTransition, getChain, recordResult, scheduleTransientRetry } from './queue.js';
import { isTransientError } from './transient.js';
import { EffectError, HandBackError, StaleDeliveryError } from './types.js';
import type {
  ChainView,
  DeadLetter,
  DeadLetterReason,
  EffectFence,
  Engine,
  Fence,
  Job,
  KernelDeps,
  ResolvedNewJob,
  Transition,
} from './types.js';
import { markChildExited, recordChild } from './workers.js';

type Db = Database.Database;

/**
 * - `succeeded`: the transition committed.
 * - `dead_lettered`: this delivery dead-lettered the job (and surfaced it).
 * - `stale`: this delivery no longer owns the job; nothing was written.
 * - `retry_scheduled`: a transient failure (network, 429, 5xx) before the agent started; the job is
 *   queued again with a delay (see `scheduleTransientRetry`) until `maxTransientRetries` is used up.
 * - `aborted`: the signal fired before the runner resolved (during workspace
 *   prepare, input building, or the run itself); nothing was written and the
 *   job is still `running` at this delivery (the caller decides). Once the
 *   runner has resolved, an abort no longer stops post-processing.
 */
export type DeliveryOutcome = 'succeeded' | 'dead_lettered' | 'stale' | 'retry_scheduled' | 'aborted';

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** True while the job is still `running` at the fence's delivery. */
function isCurrent(db: Db, fence: Fence): boolean {
  const r = db.prepare('SELECT status, delivery FROM jobs WHERE id = ?').get(fence.jobId) as
    | { status: string; delivery: number }
    | undefined;
  return r !== undefined && r.status === 'running' && r.delivery === fence.delivery;
}

/** Passes a swallowed error to `deps.onError`; a throwing handler is itself ignored. */
export function report(deps: KernelDeps, err: unknown, context: string): void {
  try {
    deps.onError?.(err, context);
  } catch {
    // An error handler must never change an outcome.
  }
}

function isTimeout(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { reason?: unknown }).reason === 'timeout';
}

/**
 * Run one claimed delivery of `job` (spec section 5, steps 2 to 6): run the
 * runner unless a result is already recorded, validate and record the result,
 * compute the transition, run its effects, and only then commit the
 * transition with its follow-on jobs. The engine's `cleanup` always runs last.
 *
 * Errors from the engine, runner and policy resolution become dead letters or
 * outcomes. Deliberately rethrown (programmer or infrastructure errors): a
 * missing chain row, and database errors other than StaleDeliveryError /
 * DeadLetterStateError from the fenced writes (e.g. SQLITE_BUSY, or a
 * commitTransition chain mismatch). `cleanup` still runs before a rethrow.
 */
export async function processDelivery(
  deps: KernelDeps,
  job: Job,
  workerId: string,
  signal: AbortSignal,
): Promise<DeliveryOutcome> {
  const { db, clock } = deps;
  const fence: Fence = { jobId: job.id, delivery: job.delivery };

  // Step 1: chain, engine, state. A missing chain is a programmer error.
  const chain = getChain(db, job.chainId);
  const rawView: ChainView<unknown> = {
    id: chain.id,
    engine: chain.engine,
    subjectKey: chain.subjectKey,
    status: chain.status,
    state: chain.engineState,
  };

  /**
   * Dead-letter the job unless this delivery is stale. The fence check and
   * the dead letter share one transaction, since `deadLetter` itself is not
   * fenced and must never clobber a newer delivery.
   */
  const deadLetterFenced = (reason: DeadLetterReason, error: string): DeadLetter | 'stale' => {
    try {
      return db
        .transaction((): DeadLetter => {
          if (!isCurrent(db, fence)) throw new StaleDeliveryError();
          return deadLetter(db, { jobId: job.id, reason, error }, clock());
        })
        .immediate();
    } catch (e) {
      if (e instanceof StaleDeliveryError || e instanceof DeadLetterStateError) return 'stale';
      throw e;
    }
  };

  let engine: Engine<any>;
  try {
    engine = deps.engines.get(chain.engine);
  } catch (e) {
    // No engine: nothing to surface the dead letter through or clean up with.
    const dl = deadLetterFenced('runner_error', message(e));
    return dl === 'stale' ? 'stale' : 'dead_lettered';
  }

  const parsed = engine.stateSchema.safeParse(chain.engineState);
  const view: ChainView<any> = parsed.success ? { ...rawView, state: parsed.data } : rawView;

  const fail = async (reason: DeadLetterReason, error: string): Promise<DeliveryOutcome> => {
    const dl = deadLetterFenced(reason, error);
    if (dl === 'stale') return 'stale';
    try {
      await engine.surfaceDeadLetter(view, dl);
      markDeadLetterSurfaced(db, dl.id, clock());
    } catch (e) {
      // Left unsurfaced: kernel maintenance retries it (surfacePending).
      report(deps, e, `surfacing the dead letter of job ${job.id}`);
    }
    return 'dead_lettered';
  };

  /**
   * A transient failure before the agent started: requeue with backoff, or dead-letter once
   * `maxTransientRetries` retries were used. Anything else is `fail`ed by the caller.
   */
  const failOrRetry = async (e: unknown, what: string): Promise<DeliveryOutcome> => {
    const max = Math.max(1, deps.config.maxTransientRetries ?? 8);
    const text = `${what}: ${message(e)}`;
    if ((job.transientRetries ?? 0) >= max) {
      return fail('runner_error', `transient_retries_exhausted after ${job.transientRetries ?? 0} retries: ${text}`);
    }
    const scheduled = scheduleTransientRetry(db, fence, clock(), text);
    return scheduled === null ? 'stale' : 'retry_scheduled';
  };

  try {
    if (!parsed.success) {
      return await fail('runner_error', `invalid engine state for chain ${chain.id}: ${parsed.error.message}`);
    }
    if (engine.onJobStart) {
      try {
        await engine.onJobStart(view, job);
      } catch (e) {
        if (signal.aborted) return 'aborted';
        if (isTransientError(e)) return await failOrRetry(e, 'onJobStart failed');
        report(deps, e, `onJobStart for job ${job.id}`);
      }
    }
    return await deliver(deps, engine, view, job, fence, workerId, signal, fail, failOrRetry);
  } finally {
    try {
      await engine.cleanup(view, job);
    } catch (e) {
      // Cleanup failures never change the outcome.
      report(deps, e, `cleanup of job ${job.id} delivery ${job.delivery}`);
    }
  }
}

async function deliver(
  deps: KernelDeps,
  engine: Engine<any>,
  view: ChainView<any>,
  job: Job,
  fence: Fence,
  workerId: string,
  signal: AbortSignal,
  fail: (reason: DeadLetterReason, error: string) => Promise<DeliveryOutcome>,
  failOrRetry: (e: unknown, what: string) => Promise<DeliveryOutcome>,
): Promise<DeliveryOutcome> {
  const { db, clock } = deps;
  let result: unknown = job.result;

  // The engine decided the job needs no run: it succeeds and the chain waits again.
  const handBack = (e: HandBackError): DeliveryOutcome => {
    try {
      commitTransition(db, fence, { chainId: view.id, engineState: e.engineState, chainStatus: 'waiting', newJobs: [] }, clock());
    } catch (err) {
      if (err instanceof StaleDeliveryError) return 'stale';
      throw err;
    }
    return 'succeeded';
  };

  // Step 2: a recorded result means a previous delivery already ran the runner.
  if (result === null) {
    // Step 3: workspace.
    let workspace: Workspace;
    try {
      workspace = await engine.workspace.prepare(view, job);
    } catch (e) {
      // An abort (worker stopping, lease lost) is not a failure of the job.
      if (signal.aborted) return 'aborted';
      if (e instanceof HandBackError) return handBack(e);
      if (isTransientError(e)) return failOrRetry(e, 'workspace prepare failed');
      return fail('runner_error', `workspace prepare failed: ${message(e)}`);
    }

    // Step 4: policy, runner, input, run.
    let input: RunInput;
    let runner;
    try {
      const policy = deps.policies.byId(job.policyId);
      runner = deps.runners.get(policy.runner);
      input = { ...(await engine.buildRunInput(view, job, workspace)), config: policy.config };
    } catch (e) {
      if (signal.aborted) return 'aborted';
      if (e instanceof HandBackError) return handBack(e);
      return fail('runner_error', message(e));
    }

    const children = new Map<number, number>();
    const hooks: RunHooks = {
      onSpawn: (c) => {
        const id = recordChild(
          db,
          { workerId, jobId: job.id, delivery: job.delivery, pid: c.pid, pgid: c.pgid, startTime: c.startTime },
          clock(),
        );
        children.set(c.pid, id);
      },
      onExit: (pid, code) => {
        const id = children.get(pid);
        if (id === undefined) return;
        markChildExited(db, id, code, clock());
        children.delete(pid);
      },
    };

    if (signal.aborted) return 'aborted';
    let output: unknown;
    try {
      output = await runner.run(input, signal, hooks);
    } catch (e) {
      // Any rejection after the signal fired (AbortError, or e.g. an exit-code
      // error from the killed child) is an abort, not a runner failure. A
      // result the runner did resolve is still processed below.
      if (signal.aborted) return 'aborted';
      if (isTimeout(e)) return fail('timeout', message(e));
      return fail('runner_error', message(e));
    }

    // Step 5: validate and record.
    const schema = engine.resultSchemas[job.type];
    if (!schema) return fail('runner_error', `engine ${engine.id} has no result schema for job type '${job.type}'`);
    const checked = schema.safeParse(output);
    if (!checked.success) {
      const issues = checked.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      return fail('runner_error', `result for job type '${job.type}' failed its schema: ${issues}`);
    }
    result = checked.data;
    try {
      recordResult(db, fence, result);
    } catch (e) {
      if (e instanceof StaleDeliveryError) return 'stale';
      throw e;
    }
  }

  // Step 6: post-processing. transition, effects, then commit.
  let t: Transition<any>;
  try {
    t = engine.transition(view, job, result);
  } catch (e) {
    return fail(e instanceof EffectError ? e.reason : 'effect_error', `transition failed: ${message(e)}`);
  }

  const effectFence: EffectFence = {
    jobId: fence.jobId,
    delivery: fence.delivery,
    assertCurrent: () => {
      if (!isCurrent(db, fence)) throw new StaleDeliveryError();
    },
  };
  // The claimed `job` predates the run: give effects the job with its recorded result.
  const done: Job = { ...job, result };
  for (const effect of t.effects) {
    try {
      const outcome = await engine.runEffect(effect, { chain: view, job: done, fence: effectFence });
      if (outcome?.engineState) t = { ...t, engineState: { ...t.engineState, ...outcome.engineState } };
      if (outcome?.finish) {
        t = { ...t, chainStatus: outcome.finish.chainStatus, newJobs: [] };
        break;
      }
    } catch (e) {
      if (e instanceof StaleDeliveryError) return 'stale';
      const reason = e instanceof EffectError ? e.reason : 'effect_error';
      return fail(reason, `effect '${effect.kind}' failed: ${message(e)}`);
    }
  }

  const newJobs: ResolvedNewJob[] = [];
  for (const n of t.newJobs) {
    try {
      const policy = deps.policies.match(n.policyKind, n.labels);
      newJobs.push({ type: n.type, attempt: n.attempt, policyId: policy.id, payload: n.payload });
    } catch (e) {
      return fail('effect_error', `cannot resolve a policy of kind '${n.policyKind}' for new job '${n.type}': ${message(e)}`);
    }
  }

  // Follow-on jobs are created only here, after every effect has run.
  try {
    commitTransition(
      db,
      fence,
      { chainId: view.id, engineState: t.engineState, chainStatus: t.chainStatus, newJobs },
      clock(),
    );
  } catch (e) {
    if (e instanceof StaleDeliveryError) return 'stale';
    throw e;
  }
  return 'succeeded';
}
