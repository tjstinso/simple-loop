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
  id: number;
  jobId: number;
  chainId: number;
  reason: DeadLetterReason;
  error: string;
  createdAt: number;
  resolvedAt: number | null;
  /** When the engine surfaced it (null: not yet, or every attempt so far failed). */
  surfacedAt: number | null;
}

export class EffectError extends Error {
  reason: 'runner_error' | 'effect_error';
  constructor(message: string, reason: 'runner_error' | 'effect_error' = 'effect_error') {
    super(message);
    this.name = 'EffectError';
    this.reason = reason;
  }
}

/**
 * Thrown by `workspace.prepare` (or `buildRunInput`) when the job needs no run: the job succeeds
 * without a result and the chain goes back to `waiting` with `engineState` (no new jobs).
 */
export class HandBackError extends Error {
  engineState: unknown;
  constructor(message: string, engineState: unknown) {
    super(message);
    this.name = 'HandBackError';
    this.engineState = engineState;
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

/** What an effect may hand back: a patch merged into the transition's engine state before it commits. */
export interface EffectOutcome<S> {
  engineState?: Partial<S>;
  /**
   * Stop here: the remaining effects are skipped and the transition commits with this chain status
   * and no new jobs (for example a feedback round that changed nothing returns the chain to `waiting`).
   */
  finish?: { chainStatus: 'waiting' };
}

/**
 * Prepares the private workspace for one job delivery. Engines are constructed
 * with their own ports; teardown belongs to `Engine.cleanup`, never the kernel.
 */
export interface WorkspaceProvider {
  prepare(chain: ChainView<any>, job: Job): Promise<Workspace>;
}

export type ReconcileOutcome<S = unknown> =
  /**
   * Nothing to do. `check` is what the pass records as the result of the look (default `none`):
   * `unknown` when GitHub had not computed mergeability yet, `error: <why>` for a transient host failure.
   */
  | { outcome: 'none'; check?: string }
  | { outcome: 'completed'; reason: string }
  | { outcome: 'cancelled'; reason: string }
  /**
   * New work for the waiting chain: the kernel creates `job`, sets the chain `active` and stores
   * `engineState`, in one transaction that only applies while the chain is still `waiting`.
   */
  | { outcome: 'new_work'; reason: string; engineState: S; job: NewJob }
  /** The chain stays `waiting` but its engine state changes (applied only while it is still `waiting`). */
  | { outcome: 'update'; reason: string; engineState: S };

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
   * the job and the fence (`RunEffectContext`). May return an `EffectOutcome` to patch the engine state
   * the transition commits (for example when the effect found a person has to take over).
   */
  runEffect(effect: Effect, ctx: RunEffectContext<S>): Promise<void | EffectOutcome<S>>;
  describe(chain: ChainView<S>): string;
  /** Removes secrets from text the kernel stores about a failure (the recorded result of a check). */
  redact?(text: string): string;
  surfaceDeadLetter(chain: ChainView<S>, dl: DeadLetter): Promise<void>;
  /**
   * Optional: called by `Kernel.retryDeadLetter` after a dead-lettered job was re-queued, with the
   * chain view and the re-queued job (for example to clear a dead-letter marker on the subject).
   * Errors are swallowed: the retry stands.
   */
  afterRetry?(chain: ChainView<S>, job: Job): Promise<void>;
  /**
   * Optional: called by `Kernel.cancelChain` (no job) and `Kernel.discardDeadLetter` (the discarded
   * job) after the chain was cancelled, with the cancelled chain view (for example to clear status
   * markers on the subject). Errors go to `KernelDeps.onError`; the cancellation stands.
   */
  afterCancel?(chain: ChainView<S>, job?: Job): Promise<void>;
  /**
   * Optional: called by `Kernel.enqueue` after the chain and its first job were created, with the
   * chain view and that job (for example to comment on the subject). Errors go to `onError`.
   */
  afterEnqueue?(chain: ChainView<S>, job: Job): Promise<void>;
  /**
   * Optional: called at the start of every delivery, once the job is claimed and before the runner
   * runs (for example to mark the subject in progress). Errors go to `onError`; the delivery continues.
   */
  onJobStart?(chain: ChainView<S>, job: Job): Promise<void>;
  /** Called after every delivery, whatever its outcome. */
  cleanup(chain: ChainView<S>, job: Job): Promise<void>;
  /**
   * Optional: called by the maintenance pass for every `waiting` chain, with its validated state, to
   * learn whether the subject was settled outside the factory (for example a person merged or closed
   * the pull request). `completed` finishes the chain (its engine state becomes `finalState(state)`
   * when defined), `cancelled` cancels it like `Kernel.cancelChain`, `none` leaves it. Must be cheap
   * and return `none` on a transient failure so the next pass retries; a thrown
   * error goes to `onError` and leaves the chain untouched.
   */
  reconcile?(chain: ChainView<S>): Promise<ReconcileOutcome<S>>;
  /** Optional: the engine state of a chain that `reconcile` completed (default: unchanged). Pure. */
  finalState?(state: S): S;
  /**
   * Optional: called after `reconcile` completed or cancelled a chain (after `afterCancel`, for a
   * cancellation), with the chain view and the outcome (for example to label and comment on the
   * subject). Errors go to `onError`; the transition stands.
   */
  afterReconcile?(chain: ChainView<S>, outcome: { outcome: 'completed' | 'cancelled'; reason: string }): Promise<void>;
  /** Optional periodic maintenance, called on the kernel's maintenance interval. */
  sweep?(now: number): Promise<void>;
}

export interface KernelDeps {
  db: Database.Database;
  engines: EngineRegistry;
  runners: RunnerRegistry;
  policies: PolicyStore;
  clock: Clock;
  config: {
    leaseMs: number;
    heartbeatMs: number;
    maxDeliveries: number;
    /** At most this many jobs run at once across all workers on the database (default: no limit). */
    maxConcurrentJobs?: number;
    /** History tables are pruned by age after this many days (default 30). */
    historyRetentionDays?: number;
  };
  /**
   * Receives errors the kernel swallows so they never change an outcome: dead-letter surfacing and
   * cleanup failures in a delivery, and errors from engine hooks (`afterRetry`, `afterCancel`).
   * `context` names what failed. Default: ignored.
   */
  onError?: (err: unknown, context: string) => void;
}
