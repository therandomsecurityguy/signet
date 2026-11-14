import { z } from 'zod';

export const RegistryGetAttestationsInputSchema = z.object({
  version_urn: z.string().min(1),
});

export const RegistryGetAttestationsOutputSchema = z.object({
  attestations: z.array(
    z.object({
      artifact_urn: z.string(),
      sha256: z.string(),
      signer: z.string(),
      key_ref: z.string(),
      algorithm: z.string(),
      predicate_type: z.string(),
      signature_valid: z.boolean(),
      subject_bound: z.boolean(),
      subject_digests: z.array(z.string()),
      attached_at: z.string(),
    }),
  ),
});

export type RegistryGetAttestationsInput = z.infer<typeof RegistryGetAttestationsInputSchema>;
export type RegistryGetAttestationsOutput = z.infer<typeof RegistryGetAttestationsOutputSchema>;
