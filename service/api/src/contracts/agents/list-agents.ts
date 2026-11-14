import { z } from 'zod';

import { AgentSummarySchema } from './common.js';

export const ListAgentsInputSchema = z.object({
  harness_name: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  offset: z.coerce.number().int().nonnegative().max(10_000).optional(),
});

export const ListAgentsOutputSchema = z.object({
  agents: z.array(AgentSummarySchema),
});

export type ListAgentsInput = z.infer<typeof ListAgentsInputSchema>;
export type ListAgentsOutput = z.infer<typeof ListAgentsOutputSchema>;
