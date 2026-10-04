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
});

export type SoftwareState = z.infer<typeof SoftwareStateSchema>;
