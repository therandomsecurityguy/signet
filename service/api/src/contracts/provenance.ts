import { z } from 'zod';

export const ProvenanceActivitySchema = z.object({
  task_urn: z.string(),
  operation: z.string(),
  status: z.string(),
  occurred_at: z.string().optional(),
  actor: z.string().optional(),
  used: z.array(z.object({ urn: z.string(), entity_type: z.string().optional() })),
  associated_agents: z.array(
    z.object({ urn: z.string(), agent_name: z.string().optional(), role: z.string().optional() }),
  ),
});

export const ProvenanceEvidenceSchema = z.object({
  /** SHA-256 over the RDFC-1.0 canonical N-Quads of the provenance export. */
  canonical_rdf_sha256: z.string(),
  /** Fetch the canonical bytes via `GET /v1/artifacts/{sha256}`. */
  canonical_rdf_artifact_urn: z.string(),
});

export const CreateProvenanceSignatureInputSchema = z.object({
  signer: z.string().min(1).max(200),
  key_ref: z.string().min(1).max(500),
  algorithm: z.string().min(1).max(100),
  signature: z.string().min(1).max(20_000),
  /**
   * Optional explicit digest the signature was produced over; must equal the
   * current canonical export digest (stale payloads are rejected — re-fetch
   * the provenance and re-sign).
   */
  provenance_sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});

export const ProvenanceSignatureRecordSchema = z.object({
  artifact_urn: z.string(),
  sha256: z.string().optional(),
  signer: z.string(),
  key_ref: z.string(),
  algorithm: z.string(),
  signed_at: z.string(),
  provenance_sha256: z.string(),
  signature: z.string(),
});

export const CreateProvenanceSignatureOutputSchema = z.object({
  provenance_signature: ProvenanceSignatureRecordSchema,
  created: z.boolean(),
});

export const ProvenanceSignatureVerificationSchema = z.object({
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
  /** `stale` = verified over an earlier, still-retrievable export (provenance grew since). */
  verdict: z.enum(['valid', 'invalid', 'stale']),
});

export const ProvenanceOutputSchema = z.object({
  entity: z.object({ urn: z.string(), entity_type: z.string() }),
  derivation_chain: z.array(
    z.object({
      version_urn: z.string(),
      was_derived_from: z.array(z.string()),
      activities: z.array(ProvenanceActivitySchema),
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
  evidence: ProvenanceEvidenceSchema,
  provenance_signatures: z.array(ProvenanceSignatureVerificationSchema),
  /** True when at least one signature exists and none is `invalid` (stale is acceptable). */
  all_provenance_signatures_verified: z.boolean(),
  /** True when at least one signature verifies over exactly the current export. */
  current_provenance_signed: z.boolean(),
});

/**
 * JSON-LD representation of the same graph (`?format=jsonld`): @type carries
 * the rdf:type IRIs; other predicates are compacted under the prov:/sg:
 * prefixes. Derived from the same triple list as the canonical N-Quads.
 */
export const ProvenanceJsonLdSchema = z.object({
  '@context': z.object({ prov: z.string(), sg: z.string() }),
  '@graph': z.array(z.object({ '@id': z.string() }).catchall(z.unknown())),
});

export type ProvenanceOutput = z.infer<typeof ProvenanceOutputSchema>;
