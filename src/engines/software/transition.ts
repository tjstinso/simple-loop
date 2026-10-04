import { EffectError } from '../../kernel/types.js';
import type { ChainView, Job, NewJob, Transition } from '../../kernel/types.js';
import type { CiPolicy } from './ci.js';
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

function followupEffects(followups: Followup[] | undefined): SoftwareEffect[] {
  return followups && followups.length > 0 ? [{ kind: 'file_followups', followups }] : [];
}

/** What a review's approval needs besides the result: the CI policy and the head the reviewer saw. */
export interface ReviewContext {
  ci?: CiPolicy | undefined;
  /** The commit the review's worktree was seeded from; null when it cannot be verified. */
  reviewedSha?: string | null;
  now?: number;
}

/** The state without the CI gate's fields (a new attempt starts without them). */
export function withoutCi(state: SoftwareState): SoftwareState {
  const { reviewedSha: _s, ci: _c, ciSince: _t, ...rest } = state;
  return rest;
}

export function softwareTransition(
  chain: ChainView<SoftwareState>,
  job: Job,
  result: unknown,
  review: ReviewContext = {},
): Transition<SoftwareState> {
  const state = withoutCi(chain.state);
  const labels = [...state.labels];

  if (job.type === 'execute') {
    const parsed = ExecutionResultSchema.safeParse(result);
    if (!parsed.success) throw new Error(`invalid execute result: ${parsed.error.message}`);
    const r = parsed.data;
    if (r.status === 'error') throw new EffectError(r.summary, 'runner_error');
    const review: NewJob = { type: 'review', attempt: state.attempt, policyKind: 'review', labels, payload: undefined };
    return {
      engineState: { ...state, labels, phase: 'reviewing' },
      chainStatus: 'active',
      newJobs: [review],
      effects: [
        { kind: 'commit_push' },
        { kind: 'open_pr' },
        // Also clears a dead-letter label a resubmit after `dlq discard` may have left behind.
        { kind: 'set_labels', target: 'issue', add: [LABEL_IN_PROGRESS], remove: [LABEL_DEAD_LETTER] },
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

    if (v.verdict === 'approve') {
      let gated: Pick<SoftwareState, 'reviewedSha' | 'ci'> | null = null;
      if (review.ci) {
        // Checks are only ever read for the exact commit the reviewer saw.
        if (!review.reviewedSha) throw new EffectError('cannot verify the reviewed head; the review will be redone', 'runner_error');
        gated = { reviewedSha: review.reviewedSha, ci: review.ci };
      }
      if (gated && profile.onApprove === 'merge') {
        return {
          engineState: { ...state, labels, phase: 'awaiting_ci', ...gated, ciSince: review.now ?? 0 },
          chainStatus: 'waiting',
          newJobs: [],
          effects: followups,
        };
      }
      if (profile.onApprove === 'merge') {
        return {
          engineState: { ...state, labels, phase: 'merged' },
          chainStatus: 'completed',
          newJobs: [],
          effects: [
            { kind: 'merge_pr' },
            { kind: 'set_labels', target: 'issue', add: [], remove: [LABEL_IN_PROGRESS] },
            ...followups,
          ],
        };
      }
      return {
        engineState: { ...state, labels, phase: 'awaiting_merge', ...gated },
        chainStatus: 'waiting',
        newJobs: [],
        effects: [
          { kind: 'set_labels', target: 'pr', add: [LABEL_READY_FOR_MERGE], remove: [LABEL_IN_PROGRESS] },
          // in-progress lives on the issue (set by the execute transition).
          { kind: 'set_labels', target: 'issue', add: [], remove: [LABEL_IN_PROGRESS] },
          ...followups,
        ],
      };
    }

    if (state.attempt < profile.maxAttempts) {
      const attempt = state.attempt + 1;
      return {
        engineState: { ...state, labels, attempt, phase: 'executing' },
        chainStatus: 'active',
        newJobs: [{ type: 'execute', attempt, policyKind: 'execute', labels, payload: { feedback: v.feedback } }],
        effects: followups,
      };
    }
    return {
      engineState: { ...state, labels, phase: 'needs_human' },
      chainStatus: 'waiting',
      newJobs: [],
      effects: [
        { kind: 'set_labels', target: 'pr', add: [LABEL_NEEDS_HUMAN], remove: [LABEL_IN_PROGRESS] },
        { kind: 'set_labels', target: 'issue', add: [], remove: [LABEL_IN_PROGRESS] },
        ...followups,
      ],
    };
  }

  throw new Error(`unknown job type: ${job.type}`);
}
