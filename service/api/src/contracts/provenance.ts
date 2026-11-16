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
