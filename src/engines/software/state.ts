import { z } from 'zod';
import { CiPolicySchema } from './ci.js';

export const PhaseSchema = z.enum(['executing', 'reviewing', 'awaiting_ci', 'awaiting_merge', 'needs_human', 'merged']);
export type Phase = z.infer<typeof PhaseSchema>;

export const SoftwareStateSchema = z.object({
  repo: z.string(),
  issueNumber: z.number().int(),
  labels: z.array(z.string()),
  profile: z.enum(['supervised', 'automatic']),
  branch: z.string(),
  attempt: z.number().int().min(1),
  phase: PhaseSchema,
  /** Set when the review policy had a `ci` object at approval: the reviewed head, the policy and when the wait began. */
  reviewedSha: z.string().optional(),
  ci: CiPolicySchema.optional(),
  ciSince: z.number().optional(),
});

export type SoftwareState = z.infer<typeof SoftwareStateSchema>;
