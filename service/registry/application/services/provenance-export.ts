/**
 * Provenance export: PROV-O projection, JSON-LD, canonical RDF digest.
 *
 * The provenance read view (`getPublicationProvenance`) is projected into a
 * deterministic PROV-O graph, canonicalized with RDFC-1.0, and exposed as a
 * content-addressed artifact so consumers get a stable, citable, offline
 * verifiable export:
 *
 * - triples come from ONE builder; the JSON-LD document and the canonical
 *   N-Quads are both derived from that list (the equivalence test asserts
 *   the bijection), so a consumer can trust either representation;
 * - emission is fully sorted, and RDFC-1.0 canonicalization is order-stable,
 *   so the digest is byte-stable across runs and storage backends;
 * - detached provenance signatures bind to `canonical_rdf_sha256` (see the
 *   provenance signature verification in the registry service).
 *
 * Vocabulary: PROV-O for the graph shape (prov:Entity/Activity/Agent,
 * wasDerivedFrom/wasGeneratedBy/used/wasAssociatedWith) plus the registry's
 * own `urn:sg:` property/entity-type encodings (shared with the canonical
 * publication projection via `sg-vocabulary.ts`).
 */

import type { RegistryPublicationProvenance } from '../ports/registry-service.js';
import { computeCanonicalRdf } from './rdf-projection.js';
import {
  dedupeAndSortTriples,
  triplesToJsonLdGraph,
  triplesToNQuads,
  RDF_TYPE_IRI as RDF_TYPE,
  type JsonLdGraphNode,
  type RdfTriple,
  type RdfTripleObject,
} from './rdf-triples.js';
import { entityTypeIri, SG_PROPERTY_PREFIX } from './sg-vocabulary.js';

const PROV = 'http://www.w3.org/ns/prov#';

/** The provenance view is the input; evidence/signature fields are computed here. */
export type ProvenanceExportInput = Omit<
  RegistryPublicationProvenance,
  'evidence' | 'provenance_signatures' | 'all_provenance_signatures_verified' | 'current_provenance_signed'
>;

export type ProvenanceTripleObject = RdfTripleObject;
export type ProvenanceTriple = RdfTriple;

/**
 * Deterministic PROV-O triple list for a provenance view. All collections
 * are sorted before emission so reordered inputs (activity/agent edge order
 * is backend-dependent) produce identical digests.
 */
export function buildProvenanceTriples(provenance: ProvenanceExportInput): ProvenanceTriple[] {
  const triples: ProvenanceTriple[] = [];
  const iri = (value: string): ProvenanceTripleObject => ({ kind: 'iri', value });
  const literal = (value: string): ProvenanceTripleObject => ({ kind: 'literal', value });
  const property = (subject: string, key: string, value: string): ProvenanceTriple => ({
    subject,
    predicate: `${SG_PROPERTY_PREFIX}${key}`,
    object: literal(value),
  });

  triples.push({ subject: provenance.entity.urn, predicate: RDF_TYPE, object: iri(`${PROV}Entity`) });
  triples.push({
    subject: provenance.entity.urn,
    predicate: RDF_TYPE,
    object: iri(entityTypeIri(provenance.entity.entity_type)),
  });

  for (const entry of provenance.derivation_chain) {
    for (const derived of [...entry.was_derived_from].sort()) {
      triples.push({ subject: entry.version_urn, predicate: `${PROV}wasDerivedFrom`, object: iri(derived) });
    }
    for (const activity of entry.activities) {
      triples.push({
        subject: entry.version_urn,
        predicate: `${PROV}wasGeneratedBy`,
        object: iri(activity.task_urn),
      });
      triples.push({ subject: activity.task_urn, predicate: RDF_TYPE, object: iri(`${PROV}Activity`) });
      triples.push(property(activity.task_urn, 'operation', activity.operation));
      triples.push(property(activity.task_urn, 'status', activity.status));
      if (activity.occurred_at) {
        triples.push(property(activity.task_urn, 'occurred_at', activity.occurred_at));
      }
      if (activity.actor) {
        triples.push(property(activity.task_urn, 'actor', activity.actor));
      }
      for (const used of [...activity.used].sort((left, right) => left.urn.localeCompare(right.urn))) {
        triples.push({ subject: activity.task_urn, predicate: `${PROV}used`, object: iri(used.urn) });
        if (used.entity_type) {
          triples.push({ subject: used.urn, predicate: RDF_TYPE, object: iri(entityTypeIri(used.entity_type)) });
        }
      }
      for (const agent of [...activity.associated_agents].sort((left, right) => left.urn.localeCompare(right.urn))) {
        triples.push({ subject: activity.task_urn, predicate: `${PROV}wasAssociatedWith`, object: iri(agent.urn) });
        triples.push({ subject: agent.urn, predicate: RDF_TYPE, object: iri(`${PROV}Agent`) });
        if (agent.agent_name) {
          triples.push(property(agent.urn, 'agent_name', agent.agent_name));
        }
        if (agent.role) {
          triples.push(property(agent.urn, 'role', agent.role));
        }
      }
    }
  }

  return dedupeAndSortTriples(triples);
}

/** N-Quads emission for the triple list (sorted, guards IRIs, escaped literals). */
export function provenanceTriplesToNQuads(triples: ProvenanceTriple[]): string[] {
  return triplesToNQuads(triples);
}

/** Canonicalize the provenance export with RDFC-1.0; the digest is the signature anchor. */
export async function canonicalizeProvenance(
  provenance: ProvenanceExportInput,
): Promise<{ nquads: string; sha256: string }> {
  return await computeCanonicalRdf(provenanceTriplesToNQuads(buildProvenanceTriples(provenance)));
}

export type ProvenanceJsonLdNode = JsonLdGraphNode;

export type ProvenanceJsonLd = {
  '@context': { prov: string; sg: string };
  '@graph': ProvenanceJsonLdNode[];
};

function compactPredicate(predicate: string): string {
  if (predicate.startsWith(PROV)) return `prov:${predicate.slice(PROV.length)}`;
  if (predicate.startsWith('urn:sg:')) return `sg:${predicate.slice('urn:sg:'.length)}`;
  return predicate;
}

/**
 * JSON-LD representation derived from the same triple list as the canonical
 * form (bijection asserted by the equivalence test).
 */
export function projectProvenanceToJsonLd(provenance: ProvenanceExportInput): ProvenanceJsonLd {
  return {
    '@context': { prov: PROV, sg: 'urn:sg:' },
    '@graph': triplesToJsonLdGraph(buildProvenanceTriples(provenance), compactPredicate),
  };
}
