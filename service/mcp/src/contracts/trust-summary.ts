import { z } from 'zod';

// MCP trust summary (build plan 2.2c). Mirror of the registry port type:
// derived state for the version a consumer is about to load.
export const TrustSummarySchema = z.object({
  publication_urn: z.string(),
  /** Newest verification moment (freshness basis); null when never verified. */
  verified_at: z.string().nullable(),
  revoked: z.boolean(),
  /** A trusted (published/certified) version newer than this one exists. */
  newer_available: z.boolean(),
  /** Certification expiry; null when the certification carries none. */
  expires_at: z.string().nullable(),
  /** Highest trusted version seen (evidence for newer_available). */
  latest_trusted_version: z.number().int().nullable(),
  /** Aggregate loads recorded for this version (build plan 3.1); null = none. */
  load_count: z.number().int().nullable(),
  last_loaded_at: z.string().nullable(),
});

export type TrustSummary = z.infer<typeof TrustSummarySchema>;
