/**
 * Deterministic authored-OWL Turtle writer (v1 subset).
 *
 * Inverse of `parseOwlOntologyTurtle` for the totally-projected subset:
 * emits `owl:Class` declarations with `rdfs:label`, `rdfs:subClassOf`,
 * `owl:disjointWith` (normalized), `urn:sg:property:concept-id` overrides,
 * and an `owl:Ontology` header. Used by de-facto promotion to append a term
 * to a NEW version of an authored-OWL ontology package.
 *
 * Guarantees:
 * - deterministic output (sorted concepts/parents/disjoint, fixed header)
 * - round-trip checked: the writer re-parses its own output and refuses
 *   (OwlOntologyError) when the document does not survive — e.g. a concept
 *   id that cannot form an IRI-safe local name and has no IRI mapping
 * - existing concepts keep their source IRIs when an `iriById` mapping is
 *   supplied; new concepts default to `urn:sg:concept:{id}`
 */

import { owlConceptLocalName, parseOwlOntologyTurtle, OwlOntologyError } from './owl-ontology.js';
import type { ProjectedOwlOntology } from './owl-ontology.js';
import type { OntologyDocument } from './ontology-validator.js';

const OWL_NS = 'http://www.w3.org/2002/07/owl#';
const CONCEPT_ID_PREDICATE = 'urn:sg:property:concept-id';
const SG_ONTOLOGY_IRI = 'urn:sg:ontology';

export function owlClassIriForConceptId(id: string): string {
  return `urn:sg:concept:${encodeURIComponent(id)}`;
}

function literal(value: string): string {
  return JSON.stringify(value);
}

export function serializeOwlOntologyTurtle(
  document: OntologyDocument,
  iriById: Record<string, string> = {},
): string {
  const iriFor = (id: string): string => iriById[id] ?? owlClassIriForConceptId(id);

  const lines: string[] = [
    `@prefix owl: <${OWL_NS}> .`,
    '@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .',
    '',
    `<${SG_ONTOLOGY_IRI}> a owl:Ontology .`,
    '',
  ];

  for (const concept of [...document.concepts].sort((left, right) => left.id.localeCompare(right.id))) {
    const iri = iriFor(concept.id);
    const statements: string[] = [];
    if (owlConceptLocalName(iri) !== concept.id) {
      statements.push(`    <${CONCEPT_ID_PREDICATE}> ${literal(concept.id)}`);
    }
    if (concept.label) {
      statements.push(`    rdfs:label ${literal(concept.label)}`);
    }
    for (const parent of [...(concept.parents ?? [])].sort()) {
      statements.push(`    rdfs:subClassOf <${iriFor(parent)}>`);
    }
    if (statements.length === 0) {
      lines.push(`<${iri}> a owl:Class .`);
    } else {
      lines.push(`<${iri}> a owl:Class ;`);
      lines.push(statements.join(' ;\n') + ' .');
    }
  }

  const disjointKeys = new Set<string>();
  for (const [left, right] of document.disjoint) {
    const pair: [string, string] = left < right ? [left, right] : [right, left];
    disjointKeys.add(JSON.stringify(pair));
  }
  for (const key of [...disjointKeys].sort()) {
    const [left, right] = JSON.parse(key) as [string, string];
    lines.push(`<${iriFor(left)}> owl:disjointWith <${iriFor(right)}> .`);
  }

  const turtle = lines.join('\n') + '\n';

  // Round-trip guard: a promoted document must survive re-parsing, with the
  // exact ids, parents, labels, disjoint pairs, and class IRIs. Anything
  // else is refused instead of silently changing semantics.
  let reparsed: ProjectedOwlOntology;
  try {
    reparsed = parseOwlOntologyTurtle(turtle);
  } catch (err) {
    throw new OwlOntologyError(
      `serialized ontology does not re-parse: ${err instanceof Error ? err.message : 'unknown error'}`,
    );
  }
  const expectedConcepts = [...document.concepts]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((concept) => JSON.stringify([concept.id, concept.label ?? null, [...(concept.parents ?? [])].sort()]));
  const actualConcepts = [...reparsed.concepts]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((concept) => JSON.stringify([concept.id, concept.label ?? null, [...(concept.parents ?? [])].sort()]));
  if (JSON.stringify(expectedConcepts) !== JSON.stringify(actualConcepts)) {
    throw new OwlOntologyError(
      'serialized ontology does not round-trip (concept ids, labels, or parents changed); the document cannot be represented in the v1 authored-OWL subset.',
    );
  }
  for (const concept of document.concepts) {
    const iri = iriFor(concept.id);
    if (reparsed.iri_by_id[concept.id] !== iri) {
      throw new OwlOntologyError(
        `concept id "${concept.id}" cannot round-trip through an authored class IRI (got ${reparsed.iri_by_id[concept.id] ?? 'none'}); use an IRI-safe id.`,
      );
    }
  }
  const expectedDisjoint = [...disjointKeys].sort();
  const actualDisjoint = reparsed.disjoint.map(([left, right]) => JSON.stringify([left, right])).sort();
  if (JSON.stringify(expectedDisjoint) !== JSON.stringify(actualDisjoint)) {
    throw new OwlOntologyError('serialized ontology does not round-trip (disjoint pairs changed).');
  }

  return turtle;
}
