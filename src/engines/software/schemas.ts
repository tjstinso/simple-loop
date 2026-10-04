import { z } from 'zod';

export const LABEL_IN_PROGRESS = 'factory:in-progress';
export const LABEL_READY_FOR_MERGE = 'factory:ready-for-merge';
export const LABEL_NEEDS_HUMAN = 'factory:needs-human';
export const LABEL_DEAD_LETTER = 'factory:dead-letter';

export const FollowupSchema = z.object({ title: z.string(), body: z.string() });
export type Followup = z.infer<typeof FollowupSchema>;

const FOLLOWUP_TITLE_MAX = 120;

/**
 * Agents are told to return follow-ups as `{ title, body }` objects, but a model sometimes returns
 * plain strings. A string becomes a follow-up whose title is its first line (capped) and whose body
 * is the whole string, so one sloppy list entry does not fail the whole job.
 */
export const LenientFollowupsSchema = z.array(
  z.union([
    FollowupSchema,
    z
      .string()
      .min(1)
      .transform((text): Followup => {
        const firstLine = text.trim().split('\n')[0] ?? '';
        return { title: firstLine.slice(0, FOLLOWUP_TITLE_MAX), body: text };
      }),
  ]),
);

export const REPLY_MAX = 2000;

export const FeedbackResponseSchema = z.object({
  id: z.string().min(1),
  action: z.enum(['changed', 'explained', 'declined']),
  reply: z.string().min(1).max(REPLY_MAX),
});
export type FeedbackResponse = z.infer<typeof FeedbackResponseSchema>;

export const ExecutionResultSchema = z.object({
  status: z.enum(['ok', 'error']),
  summary: z.string(),
  costUsd: z.number().optional(),
  /** Set by the engine when verification ran: verify rounds used and the time verification took. */
  verifyRounds: z.number().optional(),
  verifyDurationMs: z.number().optional(),
  /** Set by the engine's validation round: the verified head the push is pinned to, the commits since the seed and the first 20 of them. */
  validatedSha: z.string().optional(),
  commitCount: z.number().optional(),
  commits: z.array(z.object({ sha: z.string(), subject: z.string() })).optional(),
  steps: z.array(z.string()).optional(),
  followups: LenientFollowupsSchema.optional(),
  // A malformed list never fails the run: it counts as no responses.
  feedbackResponses: z.array(FeedbackResponseSchema).optional().catch(undefined),
});
export type ExecutionResult = z.infer<typeof ExecutionResultSchema>;

export const ReviewVerdictSchema = z.object({
  verdict: z.enum(['approve', 'request_changes']),
  feedback: z.string(),
  costUsd: z.number().optional(),
  followups: LenientFollowupsSchema.optional(),
});
export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>;

export type SoftwareEffect =
  | { kind: 'commit_push' }
  | { kind: 'open_pr' }
  | { kind: 'set_labels'; target: 'issue' | 'pr'; add: string[]; remove: string[] }
  | { kind: 'merge_pr' }
  | { kind: 'round_summary' }
  | { kind: 'post_feedback_replies' }
  | { kind: 'conflict_summary' }
  | { kind: 'ci_summary' }
  | { kind: 'comment'; target: 'issue' | 'pr'; body: string; marker: string }
  | { kind: 'file_followups'; followups: Followup[] };
