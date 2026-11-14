import { z } from 'zod';

import { SkillSummarySchema } from './common.js';

export const ListSkillsInputSchema = z.object({
  limit: z.coerce.number().int().positive().max(200).optional(),
  offset: z.coerce.number().int().nonnegative().max(10_000).optional(),
});

export const ListSkillsOutputSchema = z.object({
  skills: z.array(SkillSummarySchema),
});

export type ListSkillsInput = z.infer<typeof ListSkillsInputSchema>;
export type ListSkillsOutput = z.infer<typeof ListSkillsOutputSchema>;
