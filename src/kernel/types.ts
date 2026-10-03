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
