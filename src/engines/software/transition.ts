import { EffectError } from '../../kernel/types.js';
import type { ChainView, Job, NewJob, Transition } from '../../kernel/types.js';
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

export function softwareTransition(
  chain: ChainView<SoftwareState>,
  job: Job,
  result: unknown,
): Transition<SoftwareState> {
  const state = chain.state;
  const labels = [...state.labels];

  if (job.type === 'execute') {
    const parsed = ExecutionResultSchema.safeParse(result);
    if (!parsed.success) throw new Error(`invalid execute result: ${parsed.error.message}`);
    const r = parsed.data;
    if (r.status === 'error') throw new EffectError(r.summary, 'runner_error');
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
      : (state.humanRounds ?? 0) > 0
        ? [{ kind: 'round_summary' }]
        : [];
    const settled = { ...state, labels, phase: 'awaiting_merge' as const };
    delete settled.conflictActive;

    if (v.verdict === 'approve') {
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

    // The factory's own attempts are counted from the start of the current human round.
    if (state.attempt - (state.attemptBase ?? 0) < profile.maxAttempts) {
      const attempt = state.attempt + 1;
      return {
        engineState: { ...state, labels, attempt, phase: 'executing' },
        chainStatus: 'active',
        newJobs: [{ type: 'execute', attempt, policyKind: 'execute', labels, payload: { feedback: v.feedback } }],
        effects: followups,
      };
    }
    const stuck = { ...state, labels, phase: 'needs_human' as const };
    delete stuck.conflictActive;
    return {
      engineState: stuck,
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
