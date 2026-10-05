import { describe, expect, it } from 'vitest';
import { SoftwareStateSchema } from '../../../src/engines/software/state.js';
import { ExecutionResultSchema } from '../../../src/engines/software/schemas.js';

const base = {
  repo: 'o/r', issueNumber: 1, labels: [], profile: 'supervised', branch: 'factory/issue-1', attempt: 2, phase: 'awaiting_merge',
};

describe('state migration', () => {
  it('drops the lifetime counters and clears the sticky conflict flag when a state is read', () => {
    const s = SoftwareStateSchema.parse({ ...base, conflictRounds: 2, ciRounds: 1, humanRounds: 5, conflictGaveUp: true, phase: 'needs_human' });
    expect(s).toEqual({ ...base, phase: 'needs_human' });
    expect(s).not.toHaveProperty('conflictRounds');
    expect(s).not.toHaveProperty('conflictGaveUp');
  });

  it('accepts the new shape unchanged', () => {
    const next = { ...base, breakers: { conflict: { consecutiveFailures: 1, opens: 0 } } };
    expect(SoftwareStateSchema.parse(next)).toEqual(next);
  });
});

describe('execution result ask', () => {
  const ok = { status: 'ok', summary: 's' };
  it('accepts a question with up to 5 options', () => {
    expect(ExecutionResultSchema.safeParse({ ...ok, ask: { question: 'A or B?', options: ['A', 'B'] } }).success).toBe(true);
  });
  it.each([
    ['an empty question', { question: '' }],
    ['a question over 1000 characters', { question: 'x'.repeat(1001) }],
    ['more than 5 options', { question: 'q', options: ['1', '2', '3', '4', '5', '6'] }],
    ['an option over 200 characters', { question: 'q', options: ['x'.repeat(201)] }],
  ])('rejects %s', (_n, ask) => {
    expect(ExecutionResultSchema.safeParse({ ...ok, ask }).success).toBe(false);
  });
});
