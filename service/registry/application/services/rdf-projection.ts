/**
 * Projection of the typed publication graph to canonical RDF.
 *
 * Each publication snapshot is projected to an RDF dataset (N-Quads):
 * - the logical identity links to the snapshot via sg:hasVersion
 * - snapshot properties become triples with typed literals
 * - snapshot edges become triples with IRI objects
 *
 * The dataset is canonicalized with RDFC-1.0 (URDNA2015 successor) via
 * rdf-canonize, producing deterministic canonical RDF bytes suitable for
 * semantic signatures and digests — the semantic companion to the
 * operational canonical JSON (RFC 8785 JCS) envelope bytes.
 *
 * Term encoding is shared with the SHACL validation dataset via
 * `sg-vocabulary.ts`; changing encodings here changes signed digests.
 */

import * as rdfCanonize from 'rdf-canonize';
import { assertValidIri, literalTerm, predicateIri, propertyIri } from './sg-vocabulary.js';

export { RdfProjectionError } from './sg-vocabulary.js';

const TG_HAS_VERSION = 'urn:sg:predicate:hasVersion';

export type PublicationGraphProjectionInput = {
  publication_urn: string;
  logical_urn: string;
  properties: Record<string, unknown>;
  edges: Array<{ predicate: string; to_urn: string }>;
};

/**
 * Project the publication subgraph to deterministic N-Quads lines.
 * Properties and edges are emitted in sorted order; array values emit one
 * triple per item in sorted order. The output is feed to RDFC-1.0
 * canonicalization, so callers should not rely on line ordering.
 */
export function projectPublicationGraphToNQuads(input: PublicationGraphProjectionInput): string[] {
  assertValidIri(input.publication_urn, 'publication_urn');
  assertValidIri(input.logical_urn, 'logical_urn');
  const subject = `<${input.publication_urn}>`;
  const lines: string[] = [`<${input.logical_urn}> <${TG_HAS_VERSION}> ${subject} .`];

  for (const key of Object.keys(input.properties).sort()) {
    const value = input.properties[key];
    if (value === undefined || value === null) continue;
    const predicate = `<${propertyIri(key)}>`;
    if (Array.isArray(value)) {
      const items = value.filter((item) => item !== undefined && item !== null);
      const sorted = items.map((item) => literalTerm(item)).sort();
      for (const term of sorted) {
        lines.push(`${subject} ${predicate} ${term} .`);
      }
    } else {
      lines.push(`${subject} ${predicate} ${literalTerm(value)} .`);
    }
  }

  const edges = [...input.edges].sort((left, right) =>
    left.predicate === right.predicate ? left.to_urn.localeCompare(right.to_urn) : left.predicate.localeCompare(right.predicate),
  );
  for (const edge of edges) {
    assertValidIri(edge.to_urn, `edge target (${edge.predicate})`);
    lines.push(`${subject} <${predicateIri(edge.predicate)}> <${edge.to_urn}> .`);
  }

  return lines;
}

/**
 * Canonicalize N-Quads lines with RDFC-1.0 and compute the semantic
 * digest (SHA-256 over the canonical RDF bytes).
 */
export async function computeCanonicalRdf(lines: string[]): Promise<{ nquads: string; sha256: string }> {
  const nquads = await rdfCanonize.canonize(lines.join('\n') + '\n', {
    algorithm: 'RDFC-1.0',
    inputFormat: 'application/n-quads',
  });
  const { createHash } = await import('node:crypto');
  const sha256 = createHash('sha256').update(Buffer.from(nquads, 'utf8')).digest('hex');
  return { nquads, sha256 };
}
