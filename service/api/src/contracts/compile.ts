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
  // Authoring format of the NEW version. Defaults to the source's format;
  // 'owl-turtle' converts a legacy JSON source through the deterministic
  // OWL writer (one-way: OWL -> legacy is refused so class IRIs are never
  // silently dropped).
  target_ontology_format: z.enum(['legacy-json-v1', 'owl-turtle']).optional(),
});

export type CompileSkillInput = z.infer<typeof CompileSkillInputSchema>;
export type ReviewDeFactoTermInput = z.infer<typeof ReviewDeFactoTermInputSchema>;
