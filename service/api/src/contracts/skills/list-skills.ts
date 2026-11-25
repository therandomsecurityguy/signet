import { z } from 'zod';

import { SkillSummarySchema } from './common.js';

export const ListSkillsInputSchema = z.object({
  limit: z.coerce.number().int().positive().max(200).optional(),
  offset: z.coerce.number().int().nonnegative().max(10_000).optional(),
  /**
   * `trust` ranks the full set by the deterministic trust score
   * (certification tier dominates, then recency) before paging and includes
   * the score components on every summary.
   */
  sort: z.enum(['default', 'trust']).default('default'),
});

export const ListSkillsOutputSchema = z.object({
  skills: z.array(SkillSummarySchema),
});

export type ListSkillsInput = z.infer<typeof ListSkillsInputSchema>;
export type ListSkillsOutput = z.infer<typeof ListSkillsOutputSchema>;
