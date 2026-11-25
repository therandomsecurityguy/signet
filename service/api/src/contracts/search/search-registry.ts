import { z } from 'zod';

import { AgentSummarySchema } from '../agents/common.js';
import { SkillSummarySchema } from '../skills/common.js';
import { TrustScoreSchema } from '../trust.js';

export const SearchMatchSchema = z.object({
  mode: z.enum(['keyword', 'semantic']),
  score: z.number(),
  matched_claims: z.array(z.string()),
  matched_terms: z.array(z.string()),
  phrase_match: z.boolean(),
});

export const SearchRegistryInputSchema = z.object({
  query: z.string().min(1).max(200),
  type: z.enum(['skill', 'agent', 'all']).default('all'),
  /**
   * `keyword` (default) matches substrings over key/name/description/source;
   * `semantic` scores deterministic token and capability-claim coverage
   * (ontology concept ids) — relevance first, trust score as tie-breaker.
   */
  mode: z.enum(['keyword', 'semantic']).default('keyword'),
  /** Keyword mode only: 'default' preserves natural scan order. */
  sort: z.enum(['default', 'trust']).default('trust'),
  limit: z.coerce.number().int().positive().max(50).optional(),
});

export const SearchRegistryOutputSchema = z.object({
  query: z.string(),
  mode: z.enum(['keyword', 'semantic']),
  skills: z.array(
    SkillSummarySchema.extend({
      trust: TrustScoreSchema,
      match: SearchMatchSchema,
      active_version: z.number().optional(),
    }),
  ),
  agents: z.array(
    AgentSummarySchema.extend({
      trust: TrustScoreSchema,
      match: SearchMatchSchema,
    }),
  ),
});

export type SearchMatch = z.infer<typeof SearchMatchSchema>;
export type SearchRegistryInput = z.infer<typeof SearchRegistryInputSchema>;
export type SearchRegistryOutput = z.infer<typeof SearchRegistryOutputSchema>;
