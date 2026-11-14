import { z } from 'zod';

import { AgentVersionDetailsSchema } from './common.js';

export const ListAgentVersionsOutputSchema = z.object({
  versions: z.array(AgentVersionDetailsSchema),
});

export const ActiveAgentVersionOutputSchema = AgentVersionDetailsSchema.nullable();

export type ListAgentVersionsOutput = z.infer<typeof ListAgentVersionsOutputSchema>;
export type ActiveAgentVersionOutput = z.infer<typeof ActiveAgentVersionOutputSchema>;
