import { z } from 'zod';

// Freshness/staleness signal (build plan 2.1). Mirror of the registry port
// type; present only for versions with a verification timestamp.
export const FreshnessSchema = z.object({
  freshness: z.enum(['fresh', 'aging', 'stale']),
  last_verified_at: z.string(),
  verification_basis: z.enum(['certified_at', 'revalidated_at', 'published_at', 'validated_at']),
  age_days: z.number().int().nonnegative(),
  certification_expires_at: z.string().nullable(),
  certification_expired: z.boolean(),
  expires_in_days: z.number().int().nullable(),
  reasons: z.array(z.string()),
});

export type Freshness = z.infer<typeof FreshnessSchema>;
