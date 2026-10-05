import { describe, expect, it } from 'vitest';
import {
  canAttempt, closedBreaker, DEFAULT_BREAKER_POLICY, isExhausted, MAX_COOLDOWN_MS, modeOf, onFailure, onSuccess,
  type BreakerState,
} from '../../../src/engines/software/breaker.js';

const policy = DEFAULT_BREAKER_POLICY;
const MIN = 60_000;

/** A controllable clock: the breaker is pure, so time is just a number the test moves. */
let now = 1_000_000;
const fail = (s?: BreakerState): BreakerState => onFailure(s, now, policy);

describe('circuit breaker', () => {
  it('has the documented defaults', () => {
    expect(policy).toEqual({ failureThreshold: 3, cooldownMs: 10 * MIN, maxOpens: 3 });
    expect(MAX_COOLDOWN_MS).toBe(2 * 60 * MIN);
  });

  it('stays closed below the threshold and a success resets the count', () => {
    now = 1_000_000;
    let s = fail(fail());
    expect(s).toEqual({ consecutiveFailures: 2, opens: 0 });
    expect(canAttempt(s, now)).toBe(true);
    s = onSuccess(s);
    expect(s).toEqual(closedBreaker());
    expect(fail(fail(s))).toEqual({ consecutiveFailures: 2, opens: 0 });
  });

  it('opens at the threshold, refuses attempts during the cool-down and is half-open after it', () => {
    now = 1_000_000;
    const s = fail(fail(fail()));
    expect(s).toEqual({ consecutiveFailures: 3, opens: 1, openUntil: now + 10 * MIN });
    expect(modeOf(s, now)).toBe('open');
    expect(canAttempt(s, now + 10 * MIN - 1)).toBe(false);
    expect(modeOf(s, now + 10 * MIN)).toBe('half_open');
    expect(canAttempt(s, now + 10 * MIN)).toBe(true);
  });

  it('closes and resets everything when the half-open trial succeeds', () => {
    now = 1_000_000;
    const opened = fail(fail(fail()));
    expect(onSuccess(opened)).toEqual({ consecutiveFailures: 0, opens: 0 });
  });

  it('re-opens at once when the half-open trial fails, with the cool-down doubled', () => {
    now = 1_000_000;
    const opened = fail(fail(fail()));
    now += 10 * MIN;
    const reopened = fail(opened);
    expect(reopened).toMatchObject({ opens: 2, openUntil: now + 20 * MIN });
    now += 20 * MIN;
    expect(fail(reopened)).toMatchObject({ opens: 3, openUntil: now + 40 * MIN });
  });

  it('caps the cool-down at two hours', () => {
    now = 1_000_000;
    let s: BreakerState = { consecutiveFailures: 3, opens: 5, openUntil: now };
    s = fail(s);
    expect(s.openUntil).toBe(now + MAX_COOLDOWN_MS);
  });

  it('is exhausted after maxOpens opens', () => {
    expect(isExhausted({ consecutiveFailures: 3, opens: 2 }, policy)).toBe(false);
    expect(isExhausted({ consecutiveFailures: 3, opens: 3 }, policy)).toBe(true);
    expect(isExhausted(undefined, policy)).toBe(false);
  });

  it('honours a custom policy', () => {
    now = 5;
    const s = onFailure(undefined, now, { failureThreshold: 1, cooldownMs: 100, maxOpens: 2 });
    expect(s).toEqual({ consecutiveFailures: 1, opens: 1, openUntil: 105 });
  });
});
