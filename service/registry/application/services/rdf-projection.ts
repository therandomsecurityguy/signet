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
 */

import * as rdfCanonize from 'rdf-canonize';
import { canonicalJsonString } from './canonical-json.js';

const TG_HAS_VERSION = 'urn:sg:predicate:hasVersion';
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
const XSD_DOUBLE = 'http://www.w3.org/2001/XMLSchema#double';
const XSD_BOOLEAN = 'http://www.w3.org/2001/XMLSchema#boolean';

export type PublicationGraphProjectionInput = {
  publication_urn: string;
  logical_urn: string;
  properties: Record<string, unknown>;
  edges: Array<{ predicate: string; to_urn: string }>;
};

export class RdfProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RdfProjectionError';
  }
}

/**
 * N-Quads IRIREFs cannot contain escapes, so any character outside the
 * legal set must be rejected outright: U+0000–U+0020 (including space),
 * `<`, `>`, `"`, `{`, `}`, `|`, `^`, backtick, and backslash. URNs in the
 * publication graph are derived from user-controlled input (entity keys,
 * lineage references), so failing closed here prevents N-Quads injection
 * into the canonical RDF and its semantic digest.
 */
function assertValidIri(iri: string, context: string): void {
  for (const char of iri) {
    const code = char.codePointAt(0) as number;
    if (code <= 0x20 || code === 0x7f || '<>"{}|^`\\'.includes(char)) {
      throw new RdfProjectionError(
        `Invalid IRI character U+${code.toString(16).toUpperCase().padStart(4, '0')} in ${context}: ${JSON.stringify(iri)}`,
      );
    }
  }
}

function predicateIri(predicate: string): string {
  const iri = `urn:sg:predicate:${predicate.replaceAll(':', '-')}`;
  assertValidIri(iri, 'predicate');
  return iri;
}

function escapeLiteral(value: string): string {
  let out = '';
  for (const char of value) {
    const code = char.codePointAt(0) as number;
    if (char === '\\') out += '\\\\';
    else if (char === '"') out += '\\"';
    else if (char === '\n') out += '\\n';
    else if (char === '\r') out += '\\r';
    else if (char === '\t') out += '\\t';
    // Remaining control characters are not legal in N-Quads string
    // literals and must be escaped as \uXXXX.
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).toUpperCase().padStart(4, '0')}`;
    else out += char;
  }
  return out;
}

function literalTerm(value: unknown): string {
  if (typeof value === 'boolean') {
    return `"${value}"^^<${XSD_BOOLEAN}>`;
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? `"${value}"^^<${XSD_INTEGER}>` : `"${value}"^^<${XSD_DOUBLE}>`;
  }
  if (typeof value === 'string') {
    return `"${escapeLiteral(value)}"`;
  }
  // Nested structures (lineage, openlineage, arrays of objects) are
  // projected as canonical-JSON string literals for determinism.
  return `"${escapeLiteral(canonicalJsonString(value))}"`;
}

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
    const propertyIri = `urn:sg:property:${key}`;
    assertValidIri(propertyIri, 'property');
    const predicate = `<${propertyIri}>`;
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
