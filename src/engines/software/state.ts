import { z } from 'zod';

export const PhaseSchema = z.enum(['executing', 'reviewing', 'awaiting_merge', 'needs_human', 'merged']);
export type Phase = z.infer<typeof PhaseSchema>;

export const SoftwareStateSchema = z.object({
  repo: z.string(),
  issueNumber: z.number().int(),
  labels: z.array(z.string()),
  profile: z.enum(['supervised', 'automatic']),
  branch: z.string(),
  attempt: z.number().int().min(1),
  phase: PhaseSchema,
  /** ISO time up to which people's pull request feedback was handled (initially: when the PR was opened). */
  feedbackHandledAt: z.string().optional(),
  /** Feedback rounds started by people (absent: 0); counted apart from the factory's own review attempts. */
  humanRounds: z.number().int().min(0).optional(),
  /** `attempt` when the current human round began (absent: 0): the automated retry budget counts from here. */
  attemptBase: z.number().int().min(0).optional(),
  /** The agent's summary of the latest execute (capped), for the human round's summary comment. */
  lastSummary: z.string().optional(),
});

export type SoftwareState = z.infer<typeof SoftwareStateSchema>;
