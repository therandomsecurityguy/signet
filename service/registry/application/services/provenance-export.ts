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
 * - the digest is the anchor future work signs (detached signatures over
 *   canonical RDF bind to `canonical_rdf_sha256`, PR 2).
 *
 * Vocabulary: PROV-O for the graph shape (prov:Entity/Activity/Agent,
 * wasDerivedFrom/wasGeneratedBy/used/wasAssociatedWith) plus the registry's
 * own `urn:sg:` property/entity-type encodings (shared with the canonical
 * publication projection via `sg-vocabulary.ts`).
 */

import type { RegistryPublicationProvenance } from '../ports/registry-service.js';
import { computeCanonicalRdf } from './rdf-projection.js';
import { assertValidIri, entityTypeIri, literalTerm, SG_PROPERTY_PREFIX } from './sg-vocabulary.js';

const PROV = 'http://www.w3.org/ns/prov#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

/** The provenance view is the input; evidence/signature fields are computed here. */
export type ProvenanceExportInput = Omit<
  RegistryPublicationProvenance,
  'evidence' | 'provenance_signatures' | 'all_provenance_signatures_verified' | 'current_provenance_signed'
>;

export type ProvenanceTripleObject =
  | { kind: 'iri'; value: string }
  | { kind: 'literal'; value: string };

export type ProvenanceTriple = {
  subject: string;
  predicate: string;
  object: ProvenanceTripleObject;
};

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

  // RDF is a set: repeated statements (e.g. one agent associated with
  // several activities re-asserts its type/name) collapse to one triple.
  const deduped = [...new Map(triples.map((triple) => [
    JSON.stringify([triple.subject, triple.predicate, triple.object.kind, triple.object.value]),
    triple,
  ])).values()];

  return deduped.sort((left, right) => {
    if (left.subject !== right.subject) return left.subject < right.subject ? -1 : 1;
    if (left.predicate !== right.predicate) return left.predicate < right.predicate ? -1 : 1;
    if (left.object.kind !== right.object.kind) return left.object.kind < right.object.kind ? -1 : 1;
    if (left.object.value !== right.object.value) return left.object.value < right.object.value ? -1 : 1;
    return 0;
  });
}

/** N-Quads emission for the triple list (sorted, guards IRIs, escaped literals). */
export function provenanceTriplesToNQuads(triples: ProvenanceTriple[]): string[] {
  return triples.map((triple) => {
    assertValidIri(triple.subject, 'provenance subject');
    assertValidIri(triple.predicate, 'provenance predicate');
    const object =
      triple.object.kind === 'iri'
        ? (assertValidIri(triple.object.value, 'provenance object'), `<${triple.object.value}>`)
        : literalTerm(triple.object.value);
    return `<${triple.subject}> <${triple.predicate}> ${object} .`;
  });
}

/** Canonicalize the provenance export with RDFC-1.0; the digest is the signature anchor. */
export async function canonicalizeProvenance(
  provenance: ProvenanceExportInput,
): Promise<{ nquads: string; sha256: string }> {
  return await computeCanonicalRdf(provenanceTriplesToNQuads(buildProvenanceTriples(provenance)));
}

export type ProvenanceJsonLdNode = {
  '@id': string;
  '@type'?: string[];
  [predicate: string]: unknown;
};

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
 * form (bijection asserted by the equivalence test): `@type` carries the
 * rdf:type IRIs, other predicates are compacted where the context defines a
 * prefix, and object values are `@id`/`@value` objects. Nodes and value
 * lists are sorted for stable documents.
 */
export function projectProvenanceToJsonLd(provenance: ProvenanceExportInput): ProvenanceJsonLd {
  const triples = buildProvenanceTriples(provenance);
  const typesBySubject = new Map<string, Set<string>>();
  const predicatesBySubject = new Map<string, Map<string, Array<{ '@id': string } | { '@value': string }>>>();

  for (const triple of triples) {
    if (!predicatesBySubject.has(triple.subject)) {
      predicatesBySubject.set(triple.subject, new Map());
      typesBySubject.set(triple.subject, new Set());
    }
    if (triple.predicate === RDF_TYPE && triple.object.kind === 'iri') {
      typesBySubject.get(triple.subject)?.add(triple.object.value);
      continue;
    }
    const key = compactPredicate(triple.predicate);
    const predicates = predicatesBySubject.get(triple.subject);
    const entry = triple.object.kind === 'iri' ? { '@id': triple.object.value } : { '@value': triple.object.value };
    const existing = predicates?.get(key);
    if (existing) {
      existing.push(entry);
    } else {
      predicates?.set(key, [entry]);
    }
  }

  const graph: ProvenanceJsonLdNode[] = [...predicatesBySubject.keys()]
    .sort((left, right) => left.localeCompare(right))
    .map((subject) => {
      const node: ProvenanceJsonLdNode = { '@id': subject };
      const types = typesBySubject.get(subject);
      if (types && types.size > 0) {
        node['@type'] = [...types].sort();
      }
      const predicates = predicatesBySubject.get(subject);
      if (predicates) {
        for (const key of [...predicates.keys()].sort()) {
          node[key] = predicates.get(key);
        }
      }
      return node;
    });

  return { '@context': { prov: PROV, sg: 'urn:sg:' }, '@graph': graph };
}
