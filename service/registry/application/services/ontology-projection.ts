/**
 * Canonical RDF projection of ontology packages (both authoring formats).
 *
 * One deterministic projection from the parsed `OntologyDocument` into the
 * registry's ontology vocabulary:
 * - `urn:sg:ontology` — `owl:Ontology` with the package kind as an
 *   `urn:sg:property:kind` literal
 * - concepts — `urn:sg:concept:{encodeURIComponent(id)}` typed `owl:Class`,
 *   with `rdfs:label`, `rdfs:subClassOf` per parent and a single normalized
 *   `owl:disjointWith` per pair
 *
 * Because the projection is derived from the parsed document (not the
 * authoring bytes), an equivalent legacy-JSON and authored-OWL ontology
 * digest IDENTICALLY — the digest is over semantics, not syntax. The
 * canonical N-Quads are stored as a content-addressed artifact at
 * registration and referenced from ontology package details and the
 * validation report's ontology layer.
 */

import { computeCanonicalRdf } from './rdf-projection.js';
import { dedupeAndSortTriples, triplesToNQuads, RDF_TYPE_IRI, type RdfTriple } from './rdf-triples.js';
import type { OntologyDocument } from './ontology-validator.js';

const OWL_NS = 'http://www.w3.org/2002/07/owl#';
const RDFS_NS = 'http://www.w3.org/2000/01/rdf-schema#';
const SG_ONTOLOGY_IRI = 'urn:sg:ontology';
const SG_KIND_PREDICATE = 'urn:sg:property:kind';

export function ontologyConceptIri(id: string): string {
  return `urn:sg:concept:${encodeURIComponent(id)}`;
}

export function buildOntologyTriples(document: OntologyDocument): RdfTriple[] {
  const triples: RdfTriple[] = [
    { subject: SG_ONTOLOGY_IRI, predicate: RDF_TYPE_IRI, object: { kind: 'iri', value: `${OWL_NS}Ontology` } },
    { subject: SG_ONTOLOGY_IRI, predicate: SG_KIND_PREDICATE, object: { kind: 'literal', value: document.kind } },
  ];

  for (const concept of [...document.concepts].sort((a, b) => a.id.localeCompare(b.id))) {
    const iri = ontologyConceptIri(concept.id);
    triples.push({ subject: iri, predicate: RDF_TYPE_IRI, object: { kind: 'iri', value: `${OWL_NS}Class` } });
    if (concept.label) {
      triples.push({ subject: iri, predicate: `${RDFS_NS}label`, object: { kind: 'literal', value: concept.label } });
    }
    for (const parent of [...(concept.parents ?? [])].sort()) {
      triples.push({
        subject: iri,
        predicate: `${RDFS_NS}subClassOf`,
        object: { kind: 'iri', value: ontologyConceptIri(parent) },
      });
    }
  }

  const disjointKeys = new Set<string>();
  for (const [left, right] of document.disjoint) {
    const pair: [string, string] = left < right ? [left, right] : [right, left];
    disjointKeys.add(JSON.stringify(pair));
  }
  for (const key of [...disjointKeys].sort()) {
    const [left, right] = JSON.parse(key) as [string, string];
    triples.push({
      subject: ontologyConceptIri(left),
      predicate: `${OWL_NS}disjointWith`,
      object: { kind: 'iri', value: ontologyConceptIri(right) },
    });
  }

  return dedupeAndSortTriples(triples);
}

/** RDFC-1.0 canonical N-Quads + digest for an ontology document. */
export async function canonicalizeOntologyDocument(
  document: OntologyDocument,
): Promise<{ nquads: string; sha256: string }> {
  return await computeCanonicalRdf(triplesToNQuads(buildOntologyTriples(document)));
}
