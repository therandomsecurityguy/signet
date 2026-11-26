import { z } from 'zod';

/**
 * Deterministic trust ranking score for list/search surfaces.
 *
 * `score = tier_weight * 10 + recency_component + usage_component` — the
 * 10-point lifecycle gap guarantees tier dominance (a fresh, heavily used
 * published entity never outranks an older certified one; recency ≤ 1 and
 * usage ≤ 0.5). Components are always exposed alongside the score so
 * ordering is explainable, never a black box.
 */
export const TrustScoreSchema = z.object({
  score: z.number(),
  lifecycle_status: z.string(),
  tier_weight: z.number(),
  recency_days: z.number().nullable(),
  recency_component: z.number(),
  /** Aggregate loads recorded for the version (build plan 3.1); null = none. */
  usage_loads: z.number().int().nullable(),
  /** Capped usage bonus (100 loads saturate at 0.5). */
  usage_component: z.number(),
});

export type TrustScore = z.infer<typeof TrustScoreSchema>;
