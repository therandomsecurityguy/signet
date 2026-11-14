import { z } from 'zod';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export const RegistryGetArtifactInputSchema = z
  .object({
    sha256: z.string().regex(SHA256_PATTERN, 'sha256 must be 64 lowercase hex characters').optional(),
    artifact_urn: z
      .string()
      .regex(/^urn:sg:artifact:sha256:[0-9a-f]{64}$/, 'artifact_urn must be a sha256 artifact URN')
      .optional(),
  })
  .refine((v) => Boolean(v.sha256 || v.artifact_urn), {
    message: 'Either sha256 or artifact_urn is required.',
  });

export const RegistryGetArtifactOutputSchema = z.object({
  sha256: z.string(),
  size_bytes: z.number().int().nonnegative(),
  media_type: z.string().optional(),
  content: z.string(),
  content_truncated: z.boolean(),
  // True when the returned bytes were re-hashed and matched the requested
  // content address. Consumers must treat `false` as untrusted.
  digest_verified: z.boolean(),
});

export type RegistryGetArtifactInput = z.infer<typeof RegistryGetArtifactInputSchema>;
export type RegistryGetArtifactOutput = z.infer<typeof RegistryGetArtifactOutputSchema>;

