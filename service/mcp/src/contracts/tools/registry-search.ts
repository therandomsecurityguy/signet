import { z } from 'zod';

export const RegistrySearchTrustSchema = z.object({
  score: z.number(),
  lifecycle_status: z.string(),
  tier_weight: z.number(),
  recency_days: z.number().nullable(),
  recency_component: z.number(),
});

export const RegistrySearchMatchSchema = z.object({
  mode: z.enum(['keyword', 'semantic']),
  score: z.number(),
  matched_claims: z.array(z.string()),
  matched_terms: z.array(z.string()),
  phrase_match: z.boolean(),
});

export const RegistrySearchInputSchema = z.object({
  query: z.string().min(1).max(200),
  type: z.enum(['skill', 'agent', 'all']).default('all'),
  limit: z.number().int().positive().max(50).optional(),
  /**
   * `keyword` (default) matches substrings over key/name/description/source.
   * `semantic` scores deterministic token and capability-claim coverage
   * (ontology concept ids) and exposes match components — relevance first,
   * trust score as the tie-breaker.
   */
  mode: z.enum(['keyword', 'semantic']).default('keyword'),
  /**
   * `trust` (default) orders matches by the deterministic trust score —
   * certification tier dominates, then publication recency, ties break on
   * the logical key — and includes score components per result.
   * `default` keeps the registry's natural scan order.
   */
  sort: z.enum(['default', 'trust']).default('trust'),
});

export const RegistrySearchOutputSchema = z.object({
  query: z.string(),
  skills: z.array(
    z.object({
      skill_urn: z.string(),
      skill_key: z.string(),
      display_name: z.string().optional(),
      description: z.string().optional(),
      source_path: z.string().optional(),
      active_version: z.number().optional(),
      certification_status: z.string().optional(),
      /** Present when `sort=trust` (the default). */
      trust: RegistrySearchTrustSchema.optional(),
      /** Present when `sort=trust` (the default). */
      match: RegistrySearchMatchSchema.optional(),
    }),
  ),
  agents: z.array(
    z.object({
      agent_urn: z.string(),
      agent_key: z.string(),
      harness_name: z.string().optional(),
      display_name: z.string().optional(),
      description: z.string().optional(),
      source_path: z.string().optional(),
      /** Present when `sort=trust` (the default). */
      trust: RegistrySearchTrustSchema.optional(),
      /** Present when `sort=trust` (the default). */
      match: RegistrySearchMatchSchema.optional(),
    }),
  ),
});

export type RegistrySearchInput = z.infer<typeof RegistrySearchInputSchema>;
export type RegistrySearchOutput = z.infer<typeof RegistrySearchOutputSchema>;
export type RegistrySearchTrust = z.infer<typeof RegistrySearchTrustSchema>;
export type RegistrySearchMatch = z.infer<typeof RegistrySearchMatchSchema>;
