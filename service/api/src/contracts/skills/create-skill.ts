import { z } from 'zod';

import { entityKeySchema } from '../keys.js';
import { SkillDetailsSchema } from './common.js';

const SkillArtifactInputSchema = z.object({
  content: z.string().min(1),
  encoding: z.enum(['utf8', 'base64']).default('utf8'),
  media_type: z.string().min(1).max(200).optional(),
  original_path: z.string().min(1).max(1_000).optional(),
});

export const CreateSkillInputSchema = z.object({
  skill_key: entityKeySchema,
  display_name: z.string().min(1).max(200).optional(),
  description: z.string().min(1).max(2_000).optional(),
  source_path: z.string().min(1).max(1_000).optional(),
  artifact: SkillArtifactInputSchema.optional(),
});

export const CreateSkillOutputSchema = SkillDetailsSchema;

export type CreateSkillInput = z.infer<typeof CreateSkillInputSchema>;
export type CreateSkillOutput = z.infer<typeof CreateSkillOutputSchema>;
