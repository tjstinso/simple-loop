import { z } from 'zod';

/** The failure classes, each with its own circuit breaker. */
export const BREAKER_CLASSES = ['conflict', 'ci', 'human', 'review'] as const;
export type BreakerClass = (typeof BREAKER_CLASSES)[number];

export const BreakerStateSchema = z.object({
  consecutiveFailures: z.number().int().min(0),
  /** How many times the breaker opened since it was last closed by a success. */
  opens: z.number().int().min(0),
  /** Epoch ms: no attempts before this time; once it passed the breaker is half-open. */
  openUntil: z.number().optional(),
});
export type BreakerState = z.infer<typeof BreakerStateSchema>;

export const BreakersSchema = z.object({
  conflict: BreakerStateSchema.optional(),
  ci: BreakerStateSchema.optional(),
  human: BreakerStateSchema.optional(),
  review: BreakerStateSchema.optional(),
});
export type Breakers = z.infer<typeof BreakersSchema>;

export interface BreakerPolicy {
  /** Consecutive failures that open the breaker. */
  failureThreshold: number;
  /** Cool-down after the first open; doubled on every re-open, capped at `MAX_COOLDOWN_MS`. */
  cooldownMs: number;
  /** After this many opens the breaker raises an ask instead of waiting again. */
  maxOpens: number;
}

export const DEFAULT_BREAKER_POLICY: BreakerPolicy = { failureThreshold: 3, cooldownMs: 10 * 60_000, maxOpens: 3 };
export const MAX_COOLDOWN_MS = 2 * 3_600_000;

export const closedBreaker = (): BreakerState => ({ consecutiveFailures: 0, opens: 0 });

/** closed: attempts allowed; open: none until `openUntil`; half-open: the cool-down passed, one trial allowed. */
export type BreakerMode = 'closed' | 'open' | 'half_open';

export function modeOf(state: BreakerState | undefined, now: number): BreakerMode {
  if (state?.openUntil === undefined) return 'closed';
  return now < state.openUntil ? 'open' : 'half_open';
}

/** A success closes the breaker and resets everything. */
export function onSuccess(_state?: BreakerState): BreakerState {
  return closedBreaker();
}

/**
 * A failure. A closed breaker opens at the threshold; a failed half-open trial re-opens it at once.
 * The cool-down is `cooldownMs` doubled for every earlier open, capped.
 */
export function onFailure(state: BreakerState | undefined, now: number, policy: BreakerPolicy): BreakerState {
  const s = state ?? closedBreaker();
  const consecutiveFailures = s.consecutiveFailures + 1;
  const mode = modeOf(s, now);
  if (mode === 'open') return { ...s, consecutiveFailures };
  if (mode === 'closed' && consecutiveFailures < policy.failureThreshold) return { ...s, consecutiveFailures };
  const cooldown = Math.min(MAX_COOLDOWN_MS, policy.cooldownMs * 2 ** s.opens);
  return { consecutiveFailures, opens: s.opens + 1, openUntil: now + cooldown };
}

/** Whether an attempt may start now (closed, or half-open for its one trial). */
export function canAttempt(state: BreakerState | undefined, now: number): boolean {
  return modeOf(state, now) !== 'open';
}

/** Whether the breaker opened often enough that it has to raise an ask. */
export function isExhausted(state: BreakerState | undefined, policy: BreakerPolicy): boolean {
  return (state?.opens ?? 0) >= policy.maxOpens;
}
