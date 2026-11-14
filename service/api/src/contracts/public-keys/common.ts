import { z } from 'zod';

export const TrustedPublicKeySummarySchema = z.object({
  key_urn: z.string(),
  key_ref: z.string(),
  algorithm: z.string(),
  trust_status: z.string().optional(),
  owner: z.string().optional(),
});

export const TrustedPublicKeyDetailsSchema = z.object({
  public_key: z.object({
    urn: z.string(),
    properties: z.record(z.string(), z.unknown()),
  }),
  artifacts: z.array(
    z.object({
      artifact_urn: z.string(),
      sha256: z.string().optional(),
    }),
  ),
});

export type TrustedPublicKeySummary = z.infer<typeof TrustedPublicKeySummarySchema>;
export type TrustedPublicKeyDetails = z.infer<typeof TrustedPublicKeyDetailsSchema>;
