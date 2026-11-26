import { z } from 'zod';

// Freshness/staleness signal (build plan 2.1). Present only for versions
// with a verification timestamp (certified_at / published_at / validated_at).
export const FreshnessSchema = z.object({
  freshness: z.enum(['fresh', 'aging', 'stale']),
  /** The timestamp age is measured from (echoed as stored). */
  last_verified_at: z.string(),
  verification_basis: z.enum(['certified_at', 'revalidated_at', 'published_at', 'validated_at']),
  age_days: z.number().int().nonnegative(),
  /** Null when the certification carries no expiry. */
  certification_expires_at: z.string().nullable(),
  certification_expired: z.boolean(),
  /** Days until expiry (negative once expired); null when no expiry is set. */
  expires_in_days: z.number().int().nullable(),
  /** Machine-readable triggers: `aging`, `aged`, `certification_expired`. */
  reasons: z.array(z.string()),
});

export type Freshness = z.infer<typeof FreshnessSchema>;
