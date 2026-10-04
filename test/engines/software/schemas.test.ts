import { describe, expect, it } from 'vitest';
import { ExecutionResultSchema, FeedbackResponseSchema, ReviewVerdictSchema } from '../../../src/engines/software/schemas.js';

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

describe('feedbackResponses', () => {
  const base = { status: 'ok', summary: 's' };
  it('accepts responses with the three actions', () => {
    const feedbackResponses = [
      { id: 'comment 1', action: 'changed', reply: 'Renamed it.' },
      { id: 'review 2', action: 'explained', reply: 'Because of X.' },
      { id: 'comment 3', action: 'declined', reply: 'Out of scope.' },
    ];
    expect(ExecutionResultSchema.parse({ ...base, feedbackResponses }).feedbackResponses).toEqual(feedbackResponses);
  });

  it('is optional', () => {
    expect(ExecutionResultSchema.parse(base).feedbackResponses).toBeUndefined();
  });

  it('treats a malformed list as no responses instead of failing the result', () => {
    for (const bad of ['nope', [{ id: 'comment 1', action: 'fixed', reply: 'x' }], [{ id: 'comment 1', action: 'changed' }], [{ id: 'comment 1', action: 'changed', reply: '' }]]) {
      const r = ExecutionResultSchema.safeParse({ ...base, feedbackResponses: bad });
      expect(r.success).toBe(true);
      expect(r.data?.feedbackResponses).toBeUndefined();
    }
  });

  it('accepts a reply of 2000 characters and rejects a longer one', () => {
    const reply = (n: number) => [{ id: 'comment 1', action: 'explained', reply: 'x'.repeat(n) }];
    expect(ExecutionResultSchema.parse({ ...base, feedbackResponses: reply(2000) }).feedbackResponses).toHaveLength(1);
    expect(ExecutionResultSchema.parse({ ...base, feedbackResponses: reply(2001) }).feedbackResponses).toBeUndefined();
    expect(FeedbackResponseSchema.safeParse(reply(2001)[0]).success).toBe(false);
  });
});
