import { z } from 'zod';
import { BreakersSchema } from './breaker.js';

export const PhaseSchema = z.enum(['executing', 'reviewing', 'awaiting_merge', 'needs_human', 'needs_input', 'merged']);
export type Phase = z.infer<typeof PhaseSchema>;

/** One answer to a feedback item that still has to be posted (and its thread resolved). */
export const PendingReplySchema = z.object({
  id: z.string(),
  action: z.enum(['changed', 'explained', 'declined']),
  reply: z.string(),
  kind: z.enum(['inline', 'conversation', 'review']),
  /** The numeric id of the original comment or review. */
  numId: z.number().int(),
  /** The first line of the original, quoted in conversation replies. */
  quote: z.string(),
  /** The short sha of the commit a `changed` reply names (set when the first attempt to post it was made). */
  sha: z.string().optional(),
});
export type PendingReply = z.infer<typeof PendingReplySchema>;

const SoftwareStateObject = z.object({
  repo: z.string(),
  issueNumber: z.number().int(),
  labels: z.array(z.string()),
  profile: z.enum(['supervised', 'automatic']),
  branch: z.string(),
  attempt: z.number().int().min(1),
  phase: PhaseSchema,
  /** Number of the pull request the factory opened (absent on chains from before it was recorded). */
  prNumber: z.number().int().min(1).optional(),
  /** ISO time up to which people's pull request feedback was handled (initially: when the PR was opened). */
  feedbackHandledAt: z.string().optional(),
  /** Legacy (migrated away when a state is read): lifetime counter of feedback rounds. */
  humanRounds: z.number().int().min(0).optional(),
  /** True while the round being worked (or reviewed) answers a person's feedback. */
  humanActive: z.boolean().optional(),
  /** `feedbackHandledAt` before the current human round began: restored when the round fails, so the feedback is seen again. */
  feedbackBefore: z.string().optional(),
  /** `attempt` when the current human round began (absent: 0): the automated retry budget counts from here. */
  attemptBase: z.number().int().min(0).optional(),
  /** Legacy (migrated away): lifetime counter of conflict rounds. */
  conflictRounds: z.number().int().min(0).optional(),
  /** True while the round being worked (or reviewed) resolves a merge conflict with the base branch. */
  conflictActive: z.boolean().optional(),
  /** Legacy (migrated away, cleared): the sticky flag of a conflict handed to a person. */
  conflictGaveUp: z.boolean().optional(),
  /** The commit the chain last pushed to its branch; CI is read for exactly this head. */
  lastPushedSha: z.string().optional(),
  /** Legacy (migrated away): lifetime counter of CI rounds. */
  ciRounds: z.number().int().min(0).optional(),
  /** True while the round being worked (or reviewed) fixes failing CI checks. */
  ciActive: z.boolean().optional(),
  /** True once a CI round was approved and the checks of the pushed head are still to be seen (pass: success, fail: failure). */
  ciVerifying: z.boolean().optional(),
  /** Circuit breakers per failure class (see breaker.ts). */
  breakers: BreakersSchema.optional(),
  /** A round the reviewer rejected while its breaker was open: retried when the cool-down passed. */
  pendingFix: z.object({ cls: z.enum(['conflict', 'ci', 'human', 'review']), feedback: z.string() }).optional(),
  /** The open question the chain waits for an answer to (phase `needs_input`). */
  ask: z
    .object({
      id: z.string(),
      question: z.string(),
      reason: z.string(),
      class: z.string().optional(),
      /** ISO time the ask was raised: answers are comments, reviews and pushes after it. */
      at: z.string(),
    })
    .optional(),
  /** The chain's recorded cost when its budget was last acknowledged by an answer (the budget counts from here). */
  costBaseUsd: z.number().optional(),
  /** The agent's summary of the latest execute (capped), for the human round's summary comment. */
  lastSummary: z.string().optional(),
  /** Answers to a round's feedback items not posted yet (a failed reply is retried by maintenance). */
  pendingReplies: z.array(PendingReplySchema).optional(),
  /** Feedback items of a round the agent gave no response for, still to be named in a comment. */
  pendingUnanswered: z.object({ round: z.number().int(), ids: z.array(z.string()) }).optional(),
  /** How the latest round's items were answered, for the round summary comment. */
  lastCounts: z.object({ changed: z.number().int(), explained: z.number().int(), declined: z.number().int() }).optional(),
  /** Consecutive maintenance passes the pull request reported `unknown` mergeability (persisted across worker restarts). */
  unknown_mergeability_attempts: z.number().int().min(0).optional(),
});

/**
 * The lifetime counters and the sticky `conflictGaveUp` flag were replaced by breaker states: a state
 * with the old fields is read with the counters dropped and the flag cleared (accepted for one release).
 */
function migrate<T extends { conflictRounds?: unknown; ciRounds?: unknown; humanRounds?: unknown; conflictGaveUp?: unknown }>(s: T) {
  const { conflictRounds: _c, ciRounds: _i, humanRounds: _h, conflictGaveUp: _g, ...rest } = s;
  return rest;
}

export const SoftwareStateSchema = SoftwareStateObject.transform(migrate);

export type SoftwareState = Omit<z.infer<typeof SoftwareStateObject>, 'conflictRounds' | 'ciRounds' | 'humanRounds' | 'conflictGaveUp'>;
