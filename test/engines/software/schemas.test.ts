import { describe, expect, it } from 'vitest';
import { ExecutionResultSchema, ReviewVerdictSchema } from '../../../src/engines/software/schemas.js';

describe('lenient follow-ups', () => {
  it('accepts follow-ups as { title, body } objects unchanged', () => {
    const parsed = ReviewVerdictSchema.parse({
      verdict: 'approve',
      feedback: 'ok',
      followups: [{ title: 'Add CI', body: 'Run the tests on pull requests.' }],
    });
    expect(parsed.followups).toEqual([{ title: 'Add CI', body: 'Run the tests on pull requests.' }]);
  });

  it('turns a plain string follow-up into a title (first line, capped) and a body (the whole string)', () => {
    const long = 'x'.repeat(300);
    const parsed = ReviewVerdictSchema.parse({
      verdict: 'approve',
      feedback: 'ok',
      followups: ['Document the labels\nThey are listed in the README.', long],
    });
    expect(parsed.followups).toEqual([
      { title: 'Document the labels', body: 'Document the labels\nThey are listed in the README.' },
      { title: 'x'.repeat(120), body: long },
    ]);
  });

  it('accepts a mix of objects and strings in an execution result too', () => {
    const parsed = ExecutionResultSchema.parse({
      status: 'ok',
      summary: 'done',
      followups: ['Tidy the README', { title: 'Add CI', body: 'b' }],
    });
    expect(parsed.followups).toEqual([
      { title: 'Tidy the README', body: 'Tidy the README' },
      { title: 'Add CI', body: 'b' },
    ]);
  });

  it('still rejects an empty string and non-string, non-object entries', () => {
    expect(() => ReviewVerdictSchema.parse({ verdict: 'approve', feedback: 'ok', followups: [''] })).toThrow();
    expect(() => ReviewVerdictSchema.parse({ verdict: 'approve', feedback: 'ok', followups: [42] })).toThrow();
    expect(() =>
      ReviewVerdictSchema.parse({ verdict: 'approve', feedback: 'ok', followups: [{ title: 'only a title' }] }),
    ).toThrow();
  });
});
