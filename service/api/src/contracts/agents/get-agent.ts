import { z } from 'zod';

import { AgentDetailsSchema } from './common.js';

export const GetAgentInputSchema = z.object({
  agent_key: z.string().min(1),
});

export const GetAgentOutputSchema = AgentDetailsSchema;

export type GetAgentInput = z.infer<typeof GetAgentInputSchema>;
export type GetAgentOutput = z.infer<typeof GetAgentOutputSchema>;
