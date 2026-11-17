/**
 * Shared RDF triple list plumbing for the registry's canonical exports
 * (provenance graphs, validation reports).
 *
 * One deterministic in-memory representation feeds both encodings:
 * - N-Quads line emission (with IRI guards and escaped literals), suitable
 *   for RDFC-1.0 canonicalization and digesting;
 * - JSON-LD documents (@type for rdf:type, compacted predicates where the
 *   context defines prefixes, `@id`/`@value` objects), asserted to be a
 *   lossless representation of the same list by the equivalence tests.
 *
 * Literal objects carry raw values (string/boolean/number): `literalTerm`
 * applies the same typed-literal encoding as the signed publication
 * projection.
 */

import { assertValidIri, literalTerm } from './sg-vocabulary.js';

export const RDF_TYPE_IRI = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

export type RdfTripleObject =
  | { kind: 'iri'; value: string }
  | { kind: 'literal'; value: unknown };

export type RdfTriple = {
  subject: string;
  predicate: string;
  object: RdfTripleObject;
};

/** RDF is a set: collapse repeated statements, then order deterministically. */
export function dedupeAndSortTriples(triples: RdfTriple[]): RdfTriple[] {
  const deduped = [
    ...new Map(
      triples.map((triple) => [
        JSON.stringify([triple.subject, triple.predicate, triple.object.kind, String(triple.object.value)]),
        triple,
      ]),
    ).values(),
  ];
  return deduped.sort((left, right) => {
    if (left.subject !== right.subject) return left.subject < right.subject ? -1 : 1;
    if (left.predicate !== right.predicate) return left.predicate < right.predicate ? -1 : 1;
    if (left.object.kind !== right.object.kind) return left.object.kind < right.object.kind ? -1 : 1;
    const leftValue = String(left.object.value);
    const rightValue = String(right.object.value);
    if (leftValue !== rightValue) return leftValue < rightValue ? -1 : 1;
    return 0;
  });
}

/** N-Quads emission for a triple list (guards IRIs, escapes literals). */
export function triplesToNQuads(triples: RdfTriple[]): string[] {
  return triples.map((triple) => {
    assertValidIri(triple.subject, 'rdf subject');
    assertValidIri(triple.predicate, 'rdf predicate');
    const object =
      triple.object.kind === 'iri'
        ? (assertValidIri(triple.object.value as string, 'rdf object'), `<${triple.object.value as string}>`)
        : literalTerm(triple.object.value);
    return `<${triple.subject}> <${triple.predicate}> ${object} .`;
  });
}

export type JsonLdGraphNode = {
  '@id': string;
  '@type'?: string[];
  [predicate: string]: unknown;
};

/**
 * JSON-LD graph from a triple list: `@type` for rdf:type, predicates
 * compacted via the supplied function, `@id`/`@value` objects. Nodes and
 * value lists are sorted for stable documents.
 */
export function triplesToJsonLdGraph(
  triples: RdfTriple[],
  compactPredicate: (predicate: string) => string,
): JsonLdGraphNode[] {
  const typesBySubject = new Map<string, Set<string>>();
  const predicatesBySubject = new Map<string, Map<string, Array<{ '@id': string } | { '@value': unknown }>>>();

  for (const triple of triples) {
    if (!predicatesBySubject.has(triple.subject)) {
      predicatesBySubject.set(triple.subject, new Map());
      typesBySubject.set(triple.subject, new Set());
    }
    if (triple.predicate === RDF_TYPE_IRI && triple.object.kind === 'iri') {
      typesBySubject.get(triple.subject)?.add(triple.object.value as string);
      continue;
    }
    const key = compactPredicate(triple.predicate);
    const predicates = predicatesBySubject.get(triple.subject);
    const entry =
      triple.object.kind === 'iri'
        ? { '@id': triple.object.value as string }
        : { '@value': triple.object.value };
    const existing = predicates?.get(key);
    if (existing) {
      existing.push(entry);
    } else {
      predicates?.set(key, [entry]);
    }
  }

  return [...predicatesBySubject.keys()]
    .sort((left, right) => left.localeCompare(right))
    .map((subject) => {
      const node: JsonLdGraphNode = { '@id': subject };
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
}
