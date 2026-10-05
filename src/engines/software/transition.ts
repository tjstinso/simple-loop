import { EffectError } from '../../kernel/types.js';
import type { ChainView, Job, NewJob, Transition } from '../../kernel/types.js';
import { askMarker, buildAskComment, triedText } from './ask.js';
import {
  canAttempt,
  DEFAULT_BREAKER_POLICY,
  isExhausted,
  onFailure,
  onSuccess,
  type BreakerClass,
  type BreakerPolicy,
  type Breakers,
} from './breaker.js';
import { refsFromPayload } from './feedback.js';
import { PROFILES } from './profiles.js';
import {
  ExecutionResultSchema,
  ReviewVerdictSchema,
  LABEL_DEAD_LETTER,
  LABEL_IN_PROGRESS,
  LABEL_NEEDS_HUMAN,
  LABEL_READY_FOR_MERGE,
  type Followup,
  type SoftwareEffect,
} from './schemas.js';
import type { SoftwareState } from './state.js';

/** How much of the agent's summary the state keeps for the human round's summary comment. */
const SUMMARY_KEPT = 2000;

function followupEffects(followups: Followup[] | undefined): SoftwareEffect[] {
  return followups && followups.length > 0 ? [{ kind: 'file_followups', followups }] : [];
}

export interface TransitionOptions {
  /** The time breaker failures are recorded at (default: the real clock). */
  now?: number;
  policy?: (cls: BreakerClass) => BreakerPolicy;
}

/** The class a round of the chain belongs to, from the flags the round's start set. */
export function roundClass(s: Pick<SoftwareState, 'conflictActive' | 'ciActive' | 'humanActive'>): BreakerClass {
  return s.conflictActive ? 'conflict' : s.ciActive ? 'ci' : s.humanActive ? 'human' : 'review';
}

/** The ask hand-off as effects: one marker-guarded comment on the pull request (the issue before there is one) and the label. */
function askEffects(state: SoftwareState, chainId: number, askId: string, question: string, context: string, options?: readonly string[]): SoftwareEffect[] {
  const target = state.lastPushedSha === undefined ? 'issue' : 'pr';
  return [
    { kind: 'comment', target, body: buildAskComment(question, context, triedText(state.breakers), options), marker: askMarker(chainId, askId) },
    { kind: 'set_labels', target: 'issue', add: [LABEL_NEEDS_HUMAN], remove: [LABEL_IN_PROGRESS] },
  ];
}

export function softwareTransition(
  chain: ChainView<SoftwareState>,
  job: Job,
  result: unknown,
  opts: TransitionOptions = {},
): Transition<SoftwareState> {
  const state = chain.state;
  const labels = [...state.labels];
  const now = opts.now ?? Date.now();
  const policyOf = opts.policy ?? (() => DEFAULT_BREAKER_POLICY);

  if (job.type === 'execute') {
    const parsed = ExecutionResultSchema.safeParse(result);
    if (!parsed.success) throw new Error(`invalid execute result: ${parsed.error.message}`);
    const r = parsed.data;
    if (r.status === 'error') throw new EffectError(r.summary, 'runner_error');
    if (r.ask !== undefined) {
      // A successful run with nothing to push: the chain waits for a person's answer, no breaker is touched.
      const askId = `${chain.id}-${job.id}`;
      const asked: SoftwareState = {
        ...state,
        labels,
        phase: 'needs_input',
        ask: { id: askId, question: r.ask.question, reason: 'the agent asked', at: new Date(now).toISOString() },
        feedbackHandledAt: new Date(now).toISOString(),
      };
      delete asked.conflictActive;
      delete asked.ciActive;
      delete asked.humanActive;
      return {
        engineState: asked,
        chainStatus: 'waiting',
        newJobs: [],
        effects: [
          ...askEffects(asked, chain.id, askId, r.ask.question, `The agent stopped (attempt ${state.attempt}) because it cannot continue without a decision: ${r.summary.trim().slice(0, 500)}`, r.ask.options),
          ...followupEffects(r.followups),
        ],
      };
    }
    const review: NewJob = { type: 'review', attempt: state.attempt, policyKind: 'review', labels, payload: undefined };
    const lastSummary = r.summary.trim().slice(0, SUMMARY_KEPT);
    return {
      engineState: { ...state, labels, phase: 'reviewing', lastSummary },
      chainStatus: 'active',
      newJobs: [review],
      effects: [
        { kind: 'commit_push' },
        { kind: 'open_pr' },
        // Also clears a dead-letter label a resubmit after `dlq discard` may have left behind.
        { kind: 'set_labels', target: 'issue', add: [LABEL_IN_PROGRESS], remove: [LABEL_DEAD_LETTER] },
        // Answers a person's feedback items (a no-op when the job has none).
        ...(refsFromPayload(job.payload).length > 0 ? [{ kind: 'post_feedback_replies' } as const] : []),
        ...followupEffects(r.followups),
      ],
    };
  }

  if (job.type === 'review') {
    const parsed = ReviewVerdictSchema.safeParse(result);
    if (!parsed.success) throw new Error(`invalid review verdict: ${parsed.error.message}`);
    const v = parsed.data;
    const followups = followupEffects(v.followups);
    const profile = PROFILES[state.profile];
    // After a conflict resolution or a person's feedback, the approved revision is reported on the
    // pull request (once per round).
    const roundSummary: SoftwareEffect[] = state.conflictActive
      ? [{ kind: 'conflict_summary' }]
      : state.ciActive
        ? [{ kind: 'ci_summary' }]
        : state.humanActive
        ? [{ kind: 'round_summary' }]
        : [];
    const cls = roundClass(state);
    const settled = { ...state, labels, phase: 'awaiting_merge' as const };
    delete settled.conflictActive;
    delete settled.ciActive;
    delete settled.humanActive;
    delete settled.feedbackBefore;
    delete settled.pendingFix;

    if (v.verdict === 'approve') {
      // The round succeeded: its class closes. A CI fix only counts once the pushed head's checks pass.
      const succeeded: Breakers = { ...state.breakers, review: onSuccess(), ...(cls === 'ci' || cls === 'review' ? {} : { [cls]: onSuccess() }) };
      settled.breakers = succeeded;
      if (cls === 'ci') settled.ciVerifying = true;
      if (profile.onApprove === 'merge') {
        return {
          // Auto-merge only: GitHub merges once the required checks pass and reconcile completes the chain.
          engineState: settled,
          chainStatus: 'waiting',
          newJobs: [],
          effects: [
            { kind: 'merge_pr' },
            { kind: 'set_labels', target: 'issue', add: [], remove: [LABEL_IN_PROGRESS] },
            ...roundSummary,
            ...followups,
          ],
        };
      }
      return {
        engineState: settled,
        chainStatus: 'waiting',
        newJobs: [],
        effects: [
          { kind: 'set_labels', target: 'pr', add: [LABEL_READY_FOR_MERGE], remove: [LABEL_IN_PROGRESS] },
          // in-progress lives on the issue (set by the execute transition).
          { kind: 'set_labels', target: 'issue', add: [], remove: [LABEL_IN_PROGRESS] },
          ...roundSummary,
          ...followups,
        ],
      };
    }

    // A rejected round is a failure of its class; the breaker decides whether the agent tries again now.
    const failed = onFailure(state.breakers?.[cls], now, policyOf(cls));
    const breakers: Breakers = { ...state.breakers, [cls]: failed };
    if (canAttempt(failed, now)) {
      const attempt = state.attempt + 1;
      return {
        engineState: { ...state, labels, attempt, phase: 'executing', breakers },
        chainStatus: 'active',
        newJobs: [{ type: 'execute', attempt, policyKind: 'execute', labels, payload: { feedback: v.feedback } }],
        effects: followups,
      };
    }
    const stuck: SoftwareState = { ...state, labels, breakers };
    delete stuck.conflictActive;
    delete stuck.ciActive;
    delete stuck.humanActive;
    const leave: SoftwareEffect[] = [
      { kind: 'set_labels', target: 'issue', add: [], remove: [LABEL_IN_PROGRESS] },
      ...followups,
    ];
    if (isExhausted(failed, policyOf(cls))) {
      const askId = `${chain.id}-${job.id}`;
      const question = `The factory's reviewer keeps rejecting its work on this pull request (${cls}); what should it do differently?`;
      const asked: SoftwareState = {
        ...stuck,
        phase: 'needs_input',
        ask: { id: askId, question, reason: `breaker ${cls} opened ${failed.opens} times`, class: cls, at: new Date(now).toISOString() },
        feedbackHandledAt: new Date(now).toISOString(),
      };
      return {
        engineState: asked,
        chainStatus: 'waiting',
        newJobs: [],
        effects: [...askEffects(asked, chain.id, askId, question, `The reviewer's latest feedback: ${v.feedback.trim().slice(0, 800)}`), ...followups],
      };
    }
    // Open breaker: the chain waits and reconcile retries once the cool-down passed.
    return {
      engineState: { ...stuck, phase: 'awaiting_merge', pendingFix: { cls, feedback: v.feedback } },
      chainStatus: 'waiting',
      newJobs: [],
      effects: leave,
    };
  }

  throw new Error(`unknown job type: ${job.type}`);
}
