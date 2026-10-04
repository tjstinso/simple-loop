import type { ZodType } from 'zod';
import type { Job } from '../kernel/types.js';

export interface Workspace {
  path: string;
  [k: string]: unknown;
}

export interface RunInput {
  job: Job;
  config: unknown;
  subject: unknown;
  workspace: Workspace;
  feedback?: string;
  /** Text the engine adds to the policy prompt (placed before the work item). */
  promptAddendum?: string;
  /** What each verify command did on the unmodified tree, when the engine ran a baseline. */
  baseline?: { command: string; status: 'pass' | 'fail'; output: string }[];
  /**
   * The shared cache repository and base branch a relative plugin directory is compared against
   * (see `assertPluginDirsUnchanged`). Supplied by the engine; without it a relative entry is refused.
   */
  pluginBase?: { cacheDir: string; baseBranch: string };
}

export interface RunHooks {
  onSpawn?(child: { pid: number; pgid: number; startTime: number }): void;
  onExit?(pid: number, code: number | null): void;
}

/**
 * A runner works only inside `input.workspace.path` and returns a typed result.
 * It never publishes anything. If `signal` is aborted (before or during the run)
 * it must reject with an error whose `name` is `AbortError`.
 */
export interface Runner {
  name: string;
  configSchema: ZodType;
  run(input: RunInput, signal: AbortSignal, hooks?: RunHooks): Promise<unknown>;
}
