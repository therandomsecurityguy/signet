/**
 * Authored OWL Turtle ontology packages: parsing and validation.
 *
 * v1 supports a deliberately TIGHT subset of OWL, projected totally onto the
 * registry's `OntologyDocument` (concepts, parents, disjoint pairs, labels)
 * so validation semantics are byte-for-byte those of legacy JSON ontologies.
 * Anything outside the subset is rejected at registration — a normative
 * ontology must never be silently narrowed (a construct that is dropped
 * would change which capability claims bind).
 *
 * Supported:
 * - `owl:Class` declarations (named IRIs; ≥1 required)
 * - `rdfs:subClassOf` between declared classes (parents, as declared — no
 *   external classes, no blank nodes)
 * - `owl:disjointWith` between declared classes (symmetric; normalized)
 * - `rdfs:label` (string literal)
 * - optional `urn:sg:property:concept-id` override (string literal) — the
 *   claim-binding identifier; defaults to the class IRI's local name
 *   (`#` fragment, else last `/` or `:` segment)
 * - an `owl:Ontology` header node with `rdfs:label`
 *
 * Rejected with explicit errors: `owl:equivalentClass`,
 * `owl:unionOf`/`intersectionOf`/`complementOf`/`oneOf`, restriction blocks,
 * `owl:imports`, `owl:AllDisjointClasses`, `skos:*`, external or blank-node
 * superclasses, blank-node concepts, any other statement about a concept.
 */

import { Parser, Store, type Quad_Subject, type Term } from 'n3';

import type { OntologyConcept } from './ontology-validator.js';

const OWL_NS = 'http://www.w3.org/2002/07/owl#';
const RDFS_NS = 'http://www.w3.org/2000/01/rdf-schema#';
const SKOS_NS = 'http://www.w3.org/2004/02/skos/core#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const CONCEPT_ID = 'urn:sg:property:concept-id';

const OWL_ONTOLOGY = `${OWL_NS}Ontology`;
const OWL_CLASS = `${OWL_NS}Class`;
const OWL_RESTRICTION = `${OWL_NS}Restriction`;
const OWL_ALL_DISJOINT_CLASSES = `${OWL_NS}AllDisjointClasses`;
const RDFS_SUBCLASS_OF = `${RDFS_NS}subClassOf`;
const RDFS_LABEL = `${RDFS_NS}label`;

const REJECTED_PREDICATES: Array<{ predicate: string; label: string }> = [
  { predicate: `${OWL_NS}equivalentClass`, label: 'owl:equivalentClass' },
  { predicate: `${OWL_NS}unionOf`, label: 'owl:unionOf' },
  { predicate: `${OWL_NS}intersectionOf`, label: 'owl:intersectionOf' },
  { predicate: `${OWL_NS}complementOf`, label: 'owl:complementOf' },
  { predicate: `${OWL_NS}oneOf`, label: 'owl:oneOf' },
  { predicate: `${OWL_NS}imports`, label: 'owl:imports' },
];

export class OwlOntologyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OwlOntologyError';
  }
}

export type ProjectedOwlOntology = {
  concepts: OntologyConcept[];
  disjoint: Array<[string, string]>;
  /** Concept id -> declared class IRI (insertion deterministic by id). */
  iri_by_id: Record<string, string>;
};

/** Claim-binding id: explicit override, else the IRI's local name. */
export function owlConceptLocalName(iri: string): string | null {
  const hashIndex = iri.lastIndexOf('#');
  if (hashIndex >= 0 && hashIndex < iri.length - 1) return iri.slice(hashIndex + 1);
  const slashIndex = iri.lastIndexOf('/');
  if (slashIndex >= 0 && slashIndex < iri.length - 1) return iri.slice(slashIndex + 1);
  const colonIndex = iri.lastIndexOf(':');
  if (colonIndex >= 0 && colonIndex < iri.length - 1) return iri.slice(colonIndex + 1);
  return null;
}

export function parseOwlOntologyTurtle(turtle: string): ProjectedOwlOntology {
  let store: Store;
  try {
    store = new Store(new Parser({ format: 'text/turtle' }).parse(turtle));
  } catch (err) {
    throw new OwlOntologyError(
      `Ontology Turtle failed to parse: ${err instanceof Error ? err.message : 'unknown error'}`,
    );
  }

  for (const quad of store.getQuads(null, null, null, null)) {
    if (quad.predicate.value.startsWith(SKOS_NS)) {
      throw new OwlOntologyError(
        `skos:* is not supported in v1 (found ${quad.predicate.value}); declare concepts as owl:Class instead.`,
      );
    }
  }
  for (const rejected of REJECTED_PREDICATES) {
    if (store.getQuads(null, rejected.predicate, null, null).length > 0) {
      throw new OwlOntologyError(
        `${rejected.label} is not supported in v1: it would change concept semantics that the registry cannot project.`,
      );
    }
  }
  for (const specialClass of [OWL_RESTRICTION, OWL_ALL_DISJOINT_CLASSES]) {
    if (store.getQuads(null, RDF_TYPE, specialClass, null).length > 0) {
      throw new OwlOntologyError(
        `${specialClass.replace(OWL_NS, 'owl:')} is not supported in v1.`,
      );
    }
  }

  const headerSubjects = new Set(
    store
      .getQuads(null, RDF_TYPE, OWL_ONTOLOGY, null)
      .filter((quad) => quad.subject.termType === 'NamedNode')
      .map((quad) => quad.subject.value),
  );

  const conceptSubjects = new Map<string, Quad_Subject>();
  for (const quad of store.getQuads(null, RDF_TYPE, OWL_CLASS, null)) {
    if (quad.subject.termType !== 'NamedNode') {
      throw new OwlOntologyError('owl:Class concepts must be named IRIs (blank-node classes are not supported).');
    }
    conceptSubjects.set(quad.subject.value, quad.subject);
  }
  if (conceptSubjects.size === 0) {
    throw new OwlOntologyError('Ontology must declare at least one owl:Class concept.');
  }

  const declaredConcept = (term: Term, context: string): string => {
    if (term.termType !== 'NamedNode') {
      throw new OwlOntologyError(`${context} must be a named owl:Class declared in this document (blank nodes and external IRIs are not supported).`);
    }
    if (!conceptSubjects.has(term.value)) {
      throw new OwlOntologyError(`${context} must be an owl:Class declared in this document: ${term.value}`);
    }
    return term.value;
  };

  for (const quad of store.getQuads(null, null, null, null)) {
    const subjectIsConcept = quad.subject.termType === 'NamedNode' && conceptSubjects.has(quad.subject.value);
    if (subjectIsConcept) {
      switch (quad.predicate.value) {
        case RDF_TYPE:
          // Only the `a owl:Class` declaration itself reaches here for
          // concepts (other types were rejected by the predicate switch).
          if (quad.object.termType !== 'NamedNode' || quad.object.value !== OWL_CLASS) {
            throw new OwlOntologyError(
              `Concept ${quad.subject.value} must not declare type ${quad.object.value}; only owl:Class is supported.`,
            );
          }
          break;
        case RDFS_SUBCLASS_OF:
          declaredConcept(quad.object, `superclass referenced by ${quad.subject.value}`);
          break;
        case `${OWL_NS}disjointWith`:
          declaredConcept(quad.object, `owl:disjointWith target referenced by ${quad.subject.value}`);
          break;
        case RDFS_LABEL:
          if (quad.object.termType !== 'Literal') {
            throw new OwlOntologyError(`rdfs:label on ${quad.subject.value} must be a string literal.`);
          }
          break;
        case CONCEPT_ID:
          if (quad.object.termType !== 'Literal' || quad.object.value.trim().length === 0) {
            throw new OwlOntologyError(`${CONCEPT_ID} on ${quad.subject.value} must be a non-empty string literal.`);
          }
          break;
        default:
          throw new OwlOntologyError(
            `Statement ${quad.predicate.value} on concept ${quad.subject.value} is not supported in v1 (supported: owl:Class, rdfs:subClassOf, owl:disjointWith, rdfs:label, ${CONCEPT_ID}).`,
          );
      }
      continue;
    }
    // Non-concept subjects: only the owl:Ontology header is allowed.
    const isHeader =
      quad.subject.termType === 'NamedNode' && headerSubjects.has(quad.subject.value);
    const allowedHeaderStatement =
      isHeader &&
      ((quad.predicate.value === RDF_TYPE && quad.object.termType === 'NamedNode' && quad.object.value === OWL_ONTOLOGY) ||
        (quad.predicate.value === RDFS_LABEL && quad.object.termType === 'Literal'));
    if (!allowedHeaderStatement) {
      throw new OwlOntologyError(
        `Statement ${quad.predicate.value} on ${quad.subject.value} is not supported in v1: only owl:Class declarations and an owl:Ontology header are allowed.`,
      );
    }
  }

  // Build concept ids with collision detection (ambiguous claim binding).
  const idByIri = new Map<string, string>();
  const iriById = new Map<string, string>();
  for (const iri of [...conceptSubjects.keys()].sort()) {
    const overrideQuad = store.getQuads(iri, CONCEPT_ID, null, null)[0];
    const id =
      overrideQuad && overrideQuad.object.termType === 'Literal'
        ? overrideQuad.object.value
        : owlConceptLocalName(iri);
    if (!id) {
      throw new OwlOntologyError(
        `Cannot derive a concept id from ${iri}; add an explicit ${CONCEPT_ID} literal.`,
      );
    }
    const existingIri = iriById.get(id);
    if (existingIri && existingIri !== iri) {
      throw new OwlOntologyError(
        `Concept id "${id}" is ambiguous: ${existingIri} and ${iri} both map to it; disambiguate with ${CONCEPT_ID}.`,
      );
    }
    idByIri.set(iri, id);
    iriById.set(id, iri);
  }

  const concepts: OntologyConcept[] = [...iriById.keys()]
    .sort()
    .map((id) => {
      const iri = iriById.get(id) as string;
      const labelQuad = store.getQuads(iri, RDFS_LABEL, null, null)[0];
      const parents = store
        .getQuads(iri, RDFS_SUBCLASS_OF, null, null)
        .map((quad) => idByIri.get(quad.object.value) as string)
        .sort();
      return {
        id,
        ...(labelQuad && labelQuad.object.termType === 'Literal' ? { label: labelQuad.object.value } : {}),
        ...(parents.length > 0 ? { parents } : {}),
      };
    });

  // owl:disjointWith is symmetric: normalize the pair and dedupe.
  const disjointByKey = new Map<string, [string, string]>();
  for (const quad of store.getQuads(null, `${OWL_NS}disjointWith`, null, null)) {
    const left = idByIri.get(quad.subject.value) as string;
    const right = idByIri.get(quad.object.value) as string;
    const pair: [string, string] = left < right ? [left, right] : [right, left];
    disjointByKey.set(JSON.stringify(pair), pair);
  }
  const disjoint = [...disjointByKey.values()].sort((a, b) =>
    a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0]),
  );

  return { concepts, disjoint, iri_by_id: Object.fromEntries([...iriById.entries()].sort()) };
}
