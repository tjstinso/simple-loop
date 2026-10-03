import { z } from 'zod';

export const PolicySchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  match: z.object({ labels: z.array(z.string()) }),
  runner: z.string().min(1),
  config: z.unknown(),
  default: z.boolean().optional(),
});

export type Policy = z.infer<typeof PolicySchema>;
