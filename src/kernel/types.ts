import type Database from 'better-sqlite3';
import type { ZodType } from 'zod';
import type { PolicyStore } from '../policy/store.js';
import type { RunnerRegistry } from '../runner/registry.js';
import type { RunInput, Workspace } from '../runner/types.js';
import type { EngineRegistry } from './engine-registry.js';

export type Clock = () => number;

export type ChainStatus = 'active' | 'waiting' | 'dead_lettered' | 'completed' | 'cancelled';
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type DeadLetterReason = 'runner_error' | 'timeout' | 'max_deliveries' | 'effect_error';

export interface Chain {
  id: number;
  engine: string;
  subjectKey: string;
  status: ChainStatus;
  engineState: unknown;
}

export interface Job {
  id: number;
  chainId: number;
  type: string;
  attempt: number;
  status: JobStatus;
  policyId: string;
  payload: unknown;
  result: unknown | null;
  claimedBy: string | null;
  leaseExpiresAt: number | null;
  delivery: number;
  error: string | null;
}

export interface NewJob {
  type: string;
  attempt: number;
  policyKind: string;
  labels: string[];
  payload?: unknown;
}

export interface ResolvedNewJob {
  type: string;
  attempt: number;
  policyId: string;
  payload?: unknown;
}

export interface Fence {
  jobId: number;
  delivery: number;
}

export class StaleDeliveryError extends Error {
  constructor(message = 'stale delivery') {
    super(message);
    this.name = 'StaleDeliveryError';
  }
}

export interface ChainView<S> {
  id: number;
  engine: string;
  subjectKey: string;
  status: ChainStatus;
  state: S;
}

export interface DeadLetter {
  jobId: number;
  chainId: number;
  reason: DeadLetterReason;
  error: string;
  stepLogPath: string | null;
  createdAt: number;
  resolvedAt: number | null;
}

export class EffectError extends Error {
  reason: 'runner_error' | 'effect_error';
  constructor(message: string, reason: 'runner_error' | 'effect_error' = 'effect_error') {
    super(message);
    this.name = 'EffectError';
    this.reason = reason;
  }
}

export interface Effect {
  kind: string;
  [k: string]: unknown;
}

export interface Transition<S> {
  engineState: S;
  chainStatus: ChainStatus;
  newJobs: NewJob[];
  effects: Effect[];
}

/**
 * The fence passed to `Engine.runEffect` as `RunEffectContext.fence`. `assertCurrent` re-reads the job
 * from the database and throws StaleDeliveryError unless the job is still
 * `running` at this fence's delivery; effects call it before acting.
 */
export interface EffectFence extends Fence {
  assertCurrent(): void;
}

/** Everything the kernel hands to `Engine.runEffect`: the chain view, the job being delivered and its fence. */
export interface RunEffectContext<S> {
  chain: ChainView<S>;
  job: Job;
  fence: EffectFence;
}

/**
 * Prepares the private workspace for one job delivery. Engines are constructed
 * with their own ports; teardown belongs to `Engine.cleanup`, never the kernel.
 */
export interface WorkspaceProvider {
  prepare(chain: ChainView<any>, job: Job): Promise<Workspace>;
}

export interface Engine<S = unknown> {
  id: string;
  policyKinds: string[];
  /** Validates `chain.engineState`. */
  stateSchema: ZodType<S>;
  /** Job type -> schema for the runner's result. */
  resultSchemas: Record<string, ZodType>;
  submit(input: unknown): Promise<{ subjectKey: string; state: S; firstJob: NewJob }>;
  workspace: WorkspaceProvider;
  /** Everything the runner needs except `config`, which the kernel fills from the job's policy. */
  buildRunInput(chain: ChainView<S>, job: Job, workspace: Workspace): Promise<Omit<RunInput, 'config'>>;
  /** Pure: no I/O. */
  transition(chain: ChainView<S>, job: Job, result: unknown): Transition<S>;
  /**
   * Idempotent, check-before-act. Runs before the transition commits. `ctx` carries the chain view,
   * the job and the fence (`RunEffectContext`).
   */
  runEffect(effect: Effect, ctx: RunEffectContext<S>): Promise<void>;
  describe(chain: ChainView<S>): string;
  surfaceDeadLetter(chain: ChainView<S>, dl: DeadLetter): Promise<void>;
  /**
   * Optional: called by `Kernel.retryDeadLetter` after a dead-lettered job was re-queued, with the
   * chain view and the re-queued job (for example to clear a dead-letter marker on the subject).
   * Errors are swallowed: the retry stands.
   */
  afterRetry?(chain: ChainView<S>, job: Job): Promise<void>;
  /** Called after every delivery, whatever its outcome. */
  cleanup(chain: ChainView<S>, job: Job): Promise<void>;
  /** Optional periodic maintenance, called on the kernel's maintenance interval. */
  sweep?(now: number): Promise<void>;
}

export interface KernelDeps {
  db: Database.Database;
  engines: EngineRegistry;
  runners: RunnerRegistry;
  policies: PolicyStore;
  clock: Clock;
  config: { leaseMs: number; heartbeatMs: number; maxDeliveries: number };
}
