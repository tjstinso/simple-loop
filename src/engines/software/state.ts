import { z } from 'zod';

export const PhaseSchema = z.enum(['executing', 'reviewing', 'awaiting_merge', 'needs_human', 'merged']);
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

export const SoftwareStateSchema = z.object({
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
  /** Feedback rounds started by people (absent: 0); counted apart from the factory's own review attempts. */
  humanRounds: z.number().int().min(0).optional(),
  /** `attempt` when the current human round began (absent: 0): the automated retry budget counts from here. */
  attemptBase: z.number().int().min(0).optional(),
  /** Conflict rounds started for this chain (absent: 0); counted apart from review attempts and human rounds. */
  conflictRounds: z.number().int().min(0).optional(),
  /** True while the round being worked (or reviewed) resolves a merge conflict with the base branch. */
  conflictActive: z.boolean().optional(),
  /** True once the factory handed the conflict to a person (limit reached or not resolvable by the agent). */
  conflictGaveUp: z.boolean().optional(),
  /** The agent's summary of the latest execute (capped), for the human round's summary comment. */
  lastSummary: z.string().optional(),
  /** Answers to a round's feedback items not posted yet (a failed reply is retried by maintenance). */
  pendingReplies: z.array(PendingReplySchema).optional(),
  /** Feedback items of a round the agent gave no response for, still to be named in a comment. */
  pendingUnanswered: z.object({ round: z.number().int(), ids: z.array(z.string()) }).optional(),
  /** How the latest round's items were answered, for the round summary comment. */
  lastCounts: z.object({ changed: z.number().int(), explained: z.number().int(), declined: z.number().int() }).optional(),
});

export type SoftwareState = z.infer<typeof SoftwareStateSchema>;
