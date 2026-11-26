import { z } from 'zod';

// Aggregate usage signals (build plan 3.1): deployment-local counts and
// recencies — deliberately no identities and no per-user data.
export const UsageSignalSchema = z.object({
  kind: z.enum(['version', 'artifact']),
  publication_urn: z.string().optional(),
  artifact_sha256: z.string().optional(),
  load_count: z.number().int(),
  artifact_fetch_count: z.number().int(),
  verify_count: z.number().int(),
  verify_failure_count: z.number().int(),
  last_loaded_at: z.string().nullable(),
  last_fetched_at: z.string().nullable(),
  last_verified_at: z.string().nullable(),
  last_verify_failed_at: z.string().nullable(),
  updated_at: z.string(),
});

export const UsageSignalQuerySchema = z.object({
  publication_urn: z.string().min(1).max(500).optional(),
  artifact_sha256: z.string().regex(/^[0-9a-fA-F]{64}$/).optional(),
});

export const UsageSignalOutputSchema = z.object({
  usage: UsageSignalSchema.nullable(),
});

export type UsageSignal = z.infer<typeof UsageSignalSchema>;
export type UsageSignalQuery = z.infer<typeof UsageSignalQuerySchema>;
