import { z } from 'zod';

import { SkillDetailsSchema } from './common.js';

export const GetSkillInputSchema = z.object({
  skill_key: z.string().min(1),
});

export const GetSkillOutputSchema = SkillDetailsSchema;

export type GetSkillInput = z.infer<typeof GetSkillInputSchema>;
export type GetSkillOutput = z.infer<typeof GetSkillOutputSchema>;
