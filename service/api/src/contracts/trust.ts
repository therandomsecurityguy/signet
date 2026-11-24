import { z } from 'zod';

/**
 * Deterministic trust ranking score for list/search surfaces.
 *
 * `score = tier_weight * 10 + recency_component` — the 10-point lifecycle
 * gap guarantees tier dominance (a fresh published entity never outranks an
 * older certified one). Components are always exposed alongside the score so
 * ordering is explainable, never a black box.
 */
export const TrustScoreSchema = z.object({
  score: z.number(),
  lifecycle_status: z.string(),
  tier_weight: z.number(),
  recency_days: z.number().nullable(),
  recency_component: z.number(),
});

export type TrustScore = z.infer<typeof TrustScoreSchema>;
