import { z } from 'zod';

export const RegistryListSkillsInputSchema = z.object({
  limit: z.number().int().positive().max(200).optional(),
  offset: z.number().int().nonnegative().max(10_000).optional(),
});

export const RegistryListSkillsOutputSchema = z.object({
  skills: z.array(
    z.object({
      skill_urn: z.string(),
      skill_key: z.string(),
      source_path: z.string().optional(),
      /** Operator-curated tags (normalized: sorted, case-insensitively unique). */
      tags: z.array(z.string()).optional(),
    }),
  ),
});

export type RegistryListSkillsInput = z.infer<typeof RegistryListSkillsInputSchema>;
export type RegistryListSkillsOutput = z.infer<typeof RegistryListSkillsOutputSchema>;

