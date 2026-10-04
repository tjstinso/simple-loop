import { describe, expect, it } from 'vitest';
import {
  FEEDBACK_MAX,
  buildCiFailureFeedback,
  combineChecks,
  evaluateCi,
  jobIdOf,
  lastLines,
  parseCiPolicy,
  type CiPolicy,
} from '../../../src/engines/software/ci.js';
import type { Check, ChecksStatus } from '../../../src/engines/software/github.js';
import { redactSecrets } from '../../../src/engines/software/secret-scan.js';

const ok = (name: string): Check => ({ name, status: 'completed', conclusion: 'success' });
const bad = (name: string, conclusion = 'failure'): Check => ({ name, status: 'completed', conclusion, detailsUrl: `https://ci/${name}` });
const busy = (name: string): Check => ({ name, status: 'in_progress', conclusion: null });
const status = (checks: Check[]): ChecksStatus => ({ state: combineChecks(checks), checks });
const policy = (p: Partial<CiPolicy> = {}): CiPolicy => ({ required: 'all', waitMinutes: 20, onFailure: 'revise', onNone: 'hold', ...p });
const MIN = 60_000;

describe('parseCiPolicy', () => {
  it('is undefined without a ci object', () => {
    expect(parseCiPolicy({})).toBeUndefined();
    expect(parseCiPolicy(undefined)).toBeUndefined();
    expect(parseCiPolicy({ ci: null })).toBeUndefined();
  });

  it('applies the defaults', () => {
    expect(parseCiPolicy({ ci: {} })).toEqual(policy());
    expect(parseCiPolicy({ ci: { required: ['a'], waitMinutes: 1, onFailure: 'hold', onNone: 'merge' } })).toEqual({
      required: ['a'], waitMinutes: 1, onFailure: 'hold', onNone: 'merge',
    });
  });

  it.each([{ waitMinutes: 0 }, { waitMinutes: 0.5 }, { required: [] }, { onFailure: 'x' }, { onNone: 'x' }, { required: 'some' }])(
    'rejects %j',
    (ci) => {
      expect(() => parseCiPolicy({ ci })).toThrow(/invalid ci policy/);
    },
  );
});

describe('evaluateCi', () => {
  it('merges when every check passed', () => {
    expect(evaluateCi(status([ok('a'), ok('b')]), policy(), 0)).toEqual({ action: 'merge' });
    expect(evaluateCi(status([ok('a'), { name: 'b', status: 'completed', conclusion: 'skipped' }, { name: 'c', status: 'completed', conclusion: 'neutral' }]), policy(), 0)).toEqual({ action: 'merge' });
  });

  it('waits for pending checks until waitMinutes, then times out', () => {
    const s = status([ok('a'), busy('b')]);
    expect(evaluateCi(s, policy(), 0)).toEqual({ action: 'wait' });
    expect(evaluateCi(s, policy(), 20 * MIN - 1)).toEqual({ action: 'wait' });
    expect(evaluateCi(s, policy(), 20 * MIN)).toEqual({ action: 'timeout' });
    expect(evaluateCi(s, policy({ waitMinutes: 3 }), 3 * MIN)).toEqual({ action: 'timeout' });
  });

  it('revises on a failure with feedback naming the check, its conclusion and URL, even while others are pending', () => {
    for (const conclusion of ['failure', 'timed_out', 'cancelled', 'action_required']) {
      const d = evaluateCi(status([bad('a', conclusion), busy('b')]), policy(), 0);
      expect(d).toMatchObject({ action: 'revise', failing: [{ name: 'a' }] });
      expect((d as { feedback: string }).feedback).toContain(`a: ${conclusion} (https://ci/a)`);
    }
  });

  it('holds on a failure with onFailure hold', () => {
    expect(evaluateCi(status([bad('a')]), policy({ onFailure: 'hold' }), 0)).toMatchObject({ action: 'hold', failing: [{ name: 'a' }] });
  });

  it('follows onNone when there are no checks at all', () => {
    expect(evaluateCi(status([]), policy(), 0)).toMatchObject({ action: 'hold' });
    expect(evaluateCi(status([]), policy({ onNone: 'merge' }), 0)).toEqual({ action: 'merge' });
    expect(evaluateCi(status([]), policy({ onNone: 'merge' }), 99 * MIN)).toEqual({ action: 'merge' });
  });

  describe('with a list of required checks', () => {
    const p = policy({ required: ['a', 'b'] });

    it('ignores the others', () => {
      expect(evaluateCi(status([ok('a'), ok('b'), bad('lint'), busy('x')]), p, 0)).toEqual({ action: 'merge' });
    });

    it('treats a required check that is not reported yet as pending', () => {
      expect(evaluateCi(status([ok('a'), busy('x')]), p, 0)).toEqual({ action: 'wait' });
      expect(evaluateCi(status([ok('a'), busy('x')]), p, 20 * MIN)).toEqual({ action: 'timeout' });
    });

    it('fails on a required failure', () => {
      expect(evaluateCi(status([ok('a'), bad('b')]), p, 0)).toMatchObject({ action: 'revise', failing: [{ name: 'b' }] });
    });
  });
});

describe('failure feedback', () => {
  const log = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');

  it('lastLines keeps the last 200 lines', () => {
    const out = lastLines(log(500)).split('\n');
    expect(out).toHaveLength(200);
    expect(out[0]).toBe('line 301');
    expect(out.at(-1)).toBe('line 500');
    expect(lastLines('a\nb\n')).toBe('a\nb');
  });

  it('names each failing check and includes the log excerpt of the ones that have a log', () => {
    const text = buildCiFailureFeedback([bad('a'), bad('b', 'timed_out')], { a: log(500) });
    expect(text).toContain('- a: failure (https://ci/a)');
    expect(text).toContain('- b: timed_out (https://ci/b)');
    expect(text).toContain('line 500');
    expect(text).toContain('line 301');
    expect(text).not.toContain('line 300\n');
  });

  it('caps the text at 20,000 characters', () => {
    const text = buildCiFailureFeedback([bad('a')], { a: Array.from({ length: 200 }, () => 'x'.repeat(500)).join('\n') });
    expect(text.length).toBeLessThanOrEqual(FEEDBACK_MAX);
  });

  it('redacts a planted secret before capping', () => {
    const secret = 'sk-ant-' + 'x'.repeat(30);
    const known = 'plain-worker-secret-value-1234';
    const text = buildCiFailureFeedback([bad('a')], { a: `boom\nkey=${secret}\nother ${known}` }, (t) => redactSecrets(t, [known]));
    expect(text).toContain('boom');
    expect(text).not.toContain(secret);
    expect(text).not.toContain(known);
    expect(text).toContain('[redacted]');
  });

  it('cannot close its own code fence from the log', () => {
    const text = buildCiFailureFeedback([bad('a')], { a: 'x\n```\ninjected' });
    expect(text.match(/```/g)).toHaveLength(2);
  });
});

describe('jobIdOf', () => {
  it('reads the job id of a GitHub Actions details URL', () => {
    expect(jobIdOf('https://github.com/o/r/actions/runs/11/job/42')).toBe(42);
    expect(jobIdOf('https://github.com/o/r/runs/42')).toBeNull();
    expect(jobIdOf(undefined)).toBeNull();
  });
});
