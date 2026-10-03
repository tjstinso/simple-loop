import type Database from 'better-sqlite3';
import { migrate, openDb } from './db.js';
import { cancelChain, discardDeadLetter, retryDeadLetter } from './dlq.js';
import { report } from './process-delivery.js';
import { createChain, getChain } from './queue.js';
import type { Chain, ChainView, Engine, Job, KernelDeps } from './types.js';
import { startWorker, type Worker, type WorkerOptions } from './worker-loop.js';

export interface Kernel {
  deps: KernelDeps;
  /**
   * Create a chain and its first job through the engine's `submit`. Rejects
   * with DuplicateChainError when the subject already has an open chain, and
   * with the policy store's error when no policy matches the first job.
   */
  enqueue(engineId: string, input: unknown): Promise<{ chain: Chain; job: Job }>;
  /**
   * Re-queue a dead-lettered job (`retryDeadLetter` in dlq.ts), then call the chain engine's
   * optional `afterRetry` hook with the chain view and the re-queued job. A hook error is
   * passed to `deps.onError` and otherwise swallowed; the retry stands. Rejects (nothing changed) when the retry itself is refused.
   */
  retryDeadLetter(jobId: number): Promise<Job>;
  /**
   * Cancel a chain that is not running (`cancelChain` in dlq.ts: queued jobs cancelled, dead letters
   * resolved, subject key freed), then call the engine's optional `afterCancel` hook. Rejects
   * (nothing changed) when a job of the chain is running or the chain is already finished.
   */
  cancelChain(chainId: number): Promise<Chain>;
  /** `dlq discard`: cancel the dead-lettered job's chain, then call `afterCancel` with that job. */
  discardDeadLetter(jobId: number): Promise<void>;
  startWorker(opts?: WorkerOptions): Worker;
  close(): void;
}

export function createKernel(
  opts: Omit<KernelDeps, 'db'> &
    ({ dbPath: string; migrations?: string[] } | { db: Database.Database }),
): Kernel {
  let db: Database.Database;
  let owned: boolean;
  let rest: Omit<KernelDeps, 'db'>;
  if ('db' in opts) {
    // An already-open, already-migrated handle: used as is and never closed here.
    const { db: given, ...others } = opts;
    db = given;
    owned = false;
    rest = others;
  } else {
    const { dbPath, migrations, ...others } = opts;
    db = openDb(dbPath);
    migrate(db, migrations ?? []);
    owned = true;
    rest = others;
  }
  const deps: KernelDeps = { ...rest, db };

  /** The chain view for an engine hook: the validated state when it parses, else the raw state. */
  const viewOf = (chainId: number): { view: ChainView<unknown>; engine: Engine<any> } => {
    const chain = getChain(db, chainId);
    const engine = deps.engines.get(chain.engine);
    const parsed = engine.stateSchema.safeParse(chain.engineState);
    const view: ChainView<unknown> = {
      id: chain.id,
      engine: chain.engine,
      subjectKey: chain.subjectKey,
      status: chain.status,
      state: parsed.success ? parsed.data : chain.engineState,
    };
    return { view, engine };
  };

  /** Runs an engine's afterCancel hook; errors are reported, never thrown. */
  const afterCancel = async (chainId: number, job?: Job): Promise<void> => {
    try {
      const { view, engine } = viewOf(chainId);
      if (engine.afterCancel) await engine.afterCancel(view, job);
    } catch (e) {
      report(deps, e, `afterCancel for chain ${chainId}`);
    }
  };

  return {
    deps,
    async enqueue(engineId, input) {
      const engine = deps.engines.get(engineId);
      const { subjectKey, state, firstJob } = await engine.submit(input);
      const policy = deps.policies.match(firstJob.policyKind, firstJob.labels);
      return createChain(
        db,
        {
          engine: engine.id,
          subjectKey,
          engineState: state,
          firstJob: {
            type: firstJob.type,
            attempt: firstJob.attempt,
            policyId: policy.id,
            payload: firstJob.payload,
          },
        },
        deps.clock(),
      );
    },
    async retryDeadLetter(jobId) {
      const job = retryDeadLetter(db, jobId, deps.clock());
      try {
        const { view, engine } = viewOf(job.chainId);
        if (engine.afterRetry) await engine.afterRetry(view, job);
      } catch (e) {
        // Best effort: the retry already committed.
        report(deps, e, `afterRetry for job ${jobId}`);
      }
      return job;
    },
    async cancelChain(chainId) {
      const chain = cancelChain(db, chainId, deps.clock());
      await afterCancel(chainId);
      return chain;
    },
    async discardDeadLetter(jobId) {
      const job = discardDeadLetter(db, jobId, deps.clock());
      await afterCancel(job.chainId, job);
    },
    startWorker: (o) => startWorker(deps, o),
    close() {
      if (owned) db.close();
    },
  };
}
