import { z } from 'zod';

export const RegistryGetArtifactInputSchema = z
  .object({
    sha256: z.string().min(1).optional(),
    artifact_urn: z.string().min(1).optional(),
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

