import { describe, expect, it } from 'vitest';
import { EffectError } from '../../../src/kernel/types.js';
import type { ChainView, Job } from '../../../src/kernel/types.js';
import { softwareTransition } from '../../../src/engines/software/transition.js';
import { SoftwareStateSchema, type SoftwareState } from '../../../src/engines/software/state.js';
import {
  ExecutionResultSchema,
  ReviewVerdictSchema,
  LABEL_IN_PROGRESS,
  LABEL_READY_FOR_MERGE,
  LABEL_NEEDS_HUMAN,
  LABEL_DEAD_LETTER,
} from '../../../src/engines/software/schemas.js';
import { PROFILES } from '../../../src/engines/software/profiles.js';

const labels = ['kind:bug', 'team:a'];
const baseState = (over: Partial<SoftwareState> = {}): SoftwareState => ({
  repo: 'o/r',
  issueNumber: 7,
  labels,
  profile: 'supervised',
  branch: 'factory/issue-7',
  attempt: 1,
  phase: 'executing',
  ...over,
});
const chainOf = (state: SoftwareState): ChainView<SoftwareState> => ({
  id: 1,
  engine: 'software',
  subjectKey: 'o/r#7',
  status: 'active',
  state,
});
const jobOf = (type: string, attempt = 1): Job => ({
  id: 5,
  chainId: 1,
  type,
  attempt,
  status: 'running',
  policyId: 'p',
  payload: null,
  result: null,
  claimedBy: 'w',
  leaseExpiresAt: 100,
  delivery: 1,
  error: null,
});
const fu = { title: 'T', body: 'B' };

describe('softwareTransition', () => {
  it('execute ok -> reviewing with commit_push, open_pr, in-progress label and a review job', () => {
    const t = softwareTransition(chainOf(baseState({ attempt: 2 })), jobOf('execute', 2), { status: 'ok', summary: 's' });
    expect(t).toEqual({
      engineState: baseState({ attempt: 2, phase: 'reviewing', lastSummary: 's' }),
      chainStatus: 'active',
      effects: [
        { kind: 'commit_push' },
        { kind: 'open_pr' },
        { kind: 'set_labels', target: 'issue', add: [LABEL_IN_PROGRESS], remove: [LABEL_DEAD_LETTER] },
      ],
      newJobs: [{ type: 'review', attempt: 2, policyKind: 'review', labels, payload: undefined }],
    });
    // A resubmit after `dlq discard` must not leave a stale dead-letter label next to in-progress.
    expect(t.effects[2]).toEqual({ kind: 'set_labels', target: 'issue', add: ['factory:in-progress'], remove: ['factory:dead-letter'] });
  });

  it('supervised approve labels the PR ready-for-merge and waits', () => {
    const t = softwareTransition(chainOf(baseState({ phase: 'reviewing' })), jobOf('review'), { verdict: 'approve', feedback: 'ok' });
    expect(t).toEqual({
      engineState: baseState({ phase: 'awaiting_merge', breakers: { review: { consecutiveFailures: 0, opens: 0 } } }),
      chainStatus: 'waiting',
      effects: [
        { kind: 'set_labels', target: 'pr', add: [LABEL_READY_FOR_MERGE], remove: [LABEL_IN_PROGRESS] },
        { kind: 'set_labels', target: 'issue', add: [], remove: [LABEL_IN_PROGRESS] },
      ],
      newJobs: [],
    });
  });

  it('automatic approve enables auto-merge and waits for the merge', () => {
    const s = baseState({ profile: 'automatic', phase: 'reviewing' });
    const t = softwareTransition(chainOf(s), jobOf('review'), { verdict: 'approve', feedback: 'ok' });
    expect(t).toEqual({
      engineState: { ...s, phase: 'awaiting_merge', breakers: { review: { consecutiveFailures: 0, opens: 0 } } },
      chainStatus: 'waiting',
      effects: [
        { kind: 'merge_pr' },
        { kind: 'set_labels', target: 'issue', add: [], remove: [LABEL_IN_PROGRESS] },
      ],
      newJobs: [],
    });
  });

  it.each([1, 2])('request_changes at attempts 1 and 2 enqueues a revise execute job carrying the feedback (attempt %i)', (attempt) => {
    const t = softwareTransition(chainOf(baseState({ attempt, phase: 'reviewing' })), jobOf('review', attempt), {
      verdict: 'request_changes',
      feedback: 'fix it',
    });
    expect(t).toEqual({
      engineState: baseState({ attempt: attempt + 1, phase: 'executing', breakers: { review: { consecutiveFailures: 1, opens: 0 } } }),
      chainStatus: 'active',
      effects: [],
      newJobs: [{ type: 'execute', attempt: attempt + 1, policyKind: 'execute', labels, payload: { feedback: 'fix it' } }],
    });
  });

  it('the request_changes that reaches the failure threshold opens the review breaker and the chain waits', () => {
    const now = 1_000_000;
    const before = baseState({ attempt: 3, phase: 'reviewing', breakers: { review: { consecutiveFailures: 2, opens: 0 } } });
    const t = softwareTransition(chainOf(before), jobOf('review', 3), { verdict: 'request_changes', feedback: 'no' }, { now });
    expect(t).toEqual({
      engineState: baseState({
        attempt: 3,
        phase: 'awaiting_merge',
        breakers: { review: { consecutiveFailures: 3, opens: 1, openUntil: now + 600_000 } },
        pendingFix: { cls: 'review', feedback: 'no' },
      }),
      chainStatus: 'waiting',
      effects: [{ kind: 'set_labels', target: 'issue', add: [], remove: [LABEL_IN_PROGRESS] }],
      newJobs: [],
    });
  });

  it('the review breaker opening for the maxOpens-th time raises an ask', () => {
    const now = 1_000_000;
    const before = baseState({ attempt: 3, phase: 'reviewing', lastPushedSha: 'abc', breakers: { review: { consecutiveFailures: 2, opens: 2 } } });
    const t = softwareTransition(chainOf(before), jobOf('review', 3), { verdict: 'request_changes', feedback: 'no' }, { now });
    expect(t.engineState.phase).toBe('needs_input');
    expect(t.engineState.ask).toMatchObject({ class: 'review', at: new Date(now).toISOString() });
    expect(t.effects[0]).toMatchObject({ kind: 'comment', target: 'pr' });
    expect(t.effects[1]).toEqual({ kind: 'set_labels', target: 'issue', add: [LABEL_NEEDS_HUMAN], remove: [LABEL_IN_PROGRESS] });
  });

  it('an execute result with an ask waits for an answer: no push, no breaker touched', () => {
    const t = softwareTransition(chainOf(baseState()), jobOf('execute'), { status: 'ok', summary: 'stuck', ask: { question: 'A or B?', options: ['A', 'B'] } }, { now: 5 });
    expect(t.chainStatus).toBe('waiting');
    expect(t.newJobs).toEqual([]);
    expect(t.engineState.phase).toBe('needs_input');
    expect(t.engineState.breakers).toBeUndefined();
    expect(t.effects.map((e) => e.kind)).toEqual(['comment', 'set_labels']);
  });

  it('followups from any result add a file_followups effect', () => {
    const fx = { kind: 'file_followups', followups: [fu] };
    const exec = softwareTransition(chainOf(baseState()), jobOf('execute'), { status: 'ok', summary: 's', followups: [fu] });
    expect(exec.effects).toEqual([
      { kind: 'commit_push' },
      { kind: 'open_pr' },
      { kind: 'set_labels', target: 'issue', add: [LABEL_IN_PROGRESS], remove: [LABEL_DEAD_LETTER] },
      fx,
    ]);
    const sup = softwareTransition(chainOf(baseState({ phase: 'reviewing' })), jobOf('review'), {
      verdict: 'approve',
      feedback: '',
      followups: [fu],
    });
    expect(sup.effects).toEqual([
      { kind: 'set_labels', target: 'pr', add: [LABEL_READY_FOR_MERGE], remove: [LABEL_IN_PROGRESS] },
      { kind: 'set_labels', target: 'issue', add: [], remove: [LABEL_IN_PROGRESS] },
      fx,
    ]);
    const auto = softwareTransition(chainOf(baseState({ profile: 'automatic' })), jobOf('review'), {
      verdict: 'approve',
      feedback: '',
      followups: [fu],
    });
    expect(auto.effects.at(-1)).toEqual(fx);
    const rc = softwareTransition(chainOf(baseState()), jobOf('review'), {
      verdict: 'request_changes',
      feedback: 'x',
      followups: [fu],
    });
    expect(rc.effects).toEqual([fx]);
    const none = softwareTransition(chainOf(baseState()), jobOf('review'), {
      verdict: 'request_changes',
      feedback: 'x',
      followups: [],
    });
    expect(none.effects).toEqual([]);
  });

  it('does not mutate its inputs', () => {
    const chain = chainOf(baseState({ phase: 'reviewing', labels: [...labels] }));
    Object.freeze(chain);
    Object.freeze(chain.state);
    Object.freeze(chain.state.labels);
    const job = Object.freeze(jobOf('review'));
    const snapshot = structuredClone(chain);
    const t = softwareTransition(chain, job, { verdict: 'request_changes', feedback: 'f' });
    expect(chain).toEqual(snapshot);
    expect(t.engineState).not.toBe(chain.state);
  });

  it('execute error throws EffectError with reason runner_error', () => {
    let err: unknown;
    try {
      softwareTransition(chainOf(baseState()), jobOf('execute'), { status: 'error', summary: 'boom' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(EffectError);
    expect((err as EffectError).reason).toBe('runner_error');
    expect((err as EffectError).message).toBe('boom');
  });

  it('rejects an unknown job type', () => {
    expect(() => softwareTransition(chainOf(baseState()), jobOf('bogus'), {})).toThrow(/unknown job type/);
  });

  it('rejects an unparseable result', () => {
    expect(() => softwareTransition(chainOf(baseState()), jobOf('review'), { verdict: 'maybe' })).toThrow();
  });
});

describe('schemas', () => {
  it('SoftwareStateSchema accepts valid and rejects invalid', () => {
    expect(SoftwareStateSchema.safeParse(baseState()).success).toBe(true);
    expect(SoftwareStateSchema.safeParse({ ...baseState(), phase: 'nope' }).success).toBe(false);
    expect(SoftwareStateSchema.safeParse({ ...baseState(), profile: 'x' }).success).toBe(false);
    const { labels: _l, ...noLabels } = baseState();
    expect(SoftwareStateSchema.safeParse(noLabels).success).toBe(false);
  });
  it('ExecutionResultSchema accepts valid and rejects invalid', () => {
    expect(ExecutionResultSchema.safeParse({ status: 'ok', summary: 's', costUsd: 1, steps: ['a'], followups: [fu] }).success).toBe(true);
    expect(ExecutionResultSchema.safeParse({ status: 'ok' }).success).toBe(false);
    expect(ExecutionResultSchema.safeParse({ status: 'meh', summary: 's' }).success).toBe(false);
    expect(ExecutionResultSchema.safeParse({ status: 'ok', summary: 's', followups: [{ title: 'x' }] }).success).toBe(false);
  });
  it('ReviewVerdictSchema accepts valid and rejects invalid', () => {
    expect(ReviewVerdictSchema.safeParse({ verdict: 'approve', feedback: 'f', costUsd: 0.1 }).success).toBe(true);
    expect(ReviewVerdictSchema.safeParse({ verdict: 'approve' }).success).toBe(false);
    expect(ReviewVerdictSchema.safeParse({ verdict: 'reject', feedback: 'f' }).success).toBe(false);
  });
});
