import { migrate, openDb } from './db.js';
import { createChain } from './queue.js';
import type { Chain, Job, KernelDeps } from './types.js';
import { startWorker, type Worker, type WorkerOptions } from './worker-loop.js';

export interface Kernel {
  deps: KernelDeps;
  /**
   * Create a chain and its first job through the engine's `submit`. Rejects
   * with DuplicateChainError when the subject already has an open chain, and
   * with the policy store's error when no policy matches the first job.
   */
  enqueue(engineId: string, input: unknown): Promise<{ chain: Chain; job: Job }>;
  startWorker(opts?: WorkerOptions): Worker;
  close(): void;
}

export function createKernel(
  opts: Omit<KernelDeps, 'db'> & { dbPath: string; migrations?: string[] },
): Kernel {
  const { dbPath, migrations, ...rest } = opts;
  const db = openDb(dbPath);
  migrate(db, migrations ?? []);
  const deps: KernelDeps = { ...rest, db };

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
    startWorker: (o) => startWorker(deps, o),
    close: () => db.close(),
  };
}
