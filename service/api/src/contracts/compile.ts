import { z } from 'zod';

export const CompileSkillInputSchema = z.object({
  source_type: z.enum(['markdown', 'tool_manifest']),
  content: z.string().min(1).max(200_000),
  author: z.string().min(1).max(200),
  ontology_version: z.string().min(1).max(200).optional(),
  create_draft: z.boolean().optional(),
  skill_key: z.string().min(1).max(200).optional(),
});

export const ReviewDeFactoTermInputSchema = z.object({
  action: z.enum(['promote', 'reject']),
  author: z.string().min(1).max(200),
  source_ontology_version: z.string().min(1).max(200).optional(),
  target_ontology_version: z.string().min(1).max(200).optional(),
});

export type CompileSkillInput = z.infer<typeof CompileSkillInputSchema>;
export type ReviewDeFactoTermInput = z.infer<typeof ReviewDeFactoTermInputSchema>;
