import { z } from 'zod';

export const RegistryGetProvenanceInputSchema = z.object({
  version_urn: z.string().min(1),
});

export const RegistryGetProvenanceOutputSchema = z.object({
  entity: z.object({
    urn: z.string(),
    entity_type: z.string(),
  }),
  derivation_chain: z.array(
    z.object({
      version_urn: z.string(),
      was_derived_from: z.array(z.string()),
      activities: z.array(
        z.object({
          task_urn: z.string(),
          operation: z.string(),
          status: z.string(),
          occurred_at: z.string().optional(),
          actor: z.string().optional(),
          used: z.array(
            z.object({
              urn: z.string(),
              entity_type: z.string().optional(),
            }),
          ),
          associated_agents: z.array(
            z.object({
              urn: z.string(),
              agent_name: z.string().optional(),
              role: z.string().optional(),
            }),
          ),
        }),
      ),
    }),
  ),
  replay: z.array(
    z.object({
      occurred_at: z.string().optional(),
      operation: z.string(),
      actor: z.string().optional(),
      version_urn: z.string(),
      status: z.string(),
    }),
  ),
  /**
   * Canonical provenance export: SHA-256 over the RDFC-1.0 canonical N-Quads
   * (fetchable via /v1/artifacts/{sha256}). Optional for rolling clients.
   */
  evidence: z
    .object({
      canonical_rdf_sha256: z.string(),
      canonical_rdf_artifact_urn: z.string(),
    })
    .optional(),
  /**
   * Detached signatures over canonical provenance exports (re-verified on
   * read). Optional for rolling clients.
   */
  provenance_signatures: z
    .array(
      z.object({
        artifact_urn: z.string(),
        signer: z.string(),
        key_ref: z.string(),
        algorithm: z.string(),
        signed_at: z.string(),
        provenance_sha256: z.string(),
        artifact_present: z.boolean(),
        trusted_public_key_resolved: z.boolean(),
        cryptographic_verification_passed: z.boolean(),
        digest_matches_current: z.boolean(),
        verdict: z.enum(['valid', 'invalid', 'stale']),
      }),
    )
    .optional(),
  all_provenance_signatures_verified: z.boolean().optional(),
  current_provenance_signed: z.boolean().optional(),
});

export type RegistryGetProvenanceInput = z.infer<typeof RegistryGetProvenanceInputSchema>;
export type RegistryGetProvenanceOutput = z.infer<typeof RegistryGetProvenanceOutputSchema>;
