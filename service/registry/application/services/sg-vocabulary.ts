/**
 * Shared vocabulary and term encoding for the registry's RDF surfaces.
 *
 * Two consumers must agree byte-for-byte on how the typed publication graph
 * maps to RDF terms:
 * - `rdf-projection.ts`: the canonical *signed* projection (RDFC-1.0
 *   semantic digests) — never change without re-pinning digests.
 * - the SHACL validation dataset derived from the same graph (unsigned,
 *   validated in-process).
 *
 * Keeping the IRI/literal encoders in one module prevents the two datasets
 * from drifting apart (a mismatch would silently change class checks or
 * shape targeting).
 */

import { canonicalJsonString } from './canonical-json.js';

const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
const XSD_DOUBLE = 'http://www.w3.org/2001/XMLSchema#double';
const XSD_BOOLEAN = 'http://www.w3.org/2001/XMLSchema#boolean';

/**
 * Entity-type marker IRI prefix. Shapes never target these classes directly
 * (validation uses `sh:targetNode`); the triples exist so `sh:class` can
 * check edge targets.
 */
export const SG_ENTITY_TYPE_PREFIX = 'urn:sg:entity-type:';

/** Property IRI prefix (mirrors the canonical projection). */
export const SG_PROPERTY_PREFIX = 'urn:sg:property:';

/** Edge predicate IRI prefix (mirrors the canonical projection). */
export const SG_PREDICATE_PREFIX = 'urn:sg:predicate:';

/**
 * Datatype for nested structures (objects/arrays) carried as canonical-JSON
 * literals in the *validation* dataset. Deliberately not xsd:string: the
 * legacy validator only accepted primitive JS strings for
 * `datatype: "string"`, and a plain literal would wrongly satisfy
 * `sh:datatype xsd:string`.
 */
export const SG_JSON_DATATYPE = 'urn:sg:datatype:json';

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
export function assertValidIri(iri: string, context: string): void {
  for (const char of iri) {
    const code = char.codePointAt(0) as number;
    if (code <= 0x20 || code === 0x7f || '<>"{}|^`\\'.includes(char)) {
      throw new RdfProjectionError(
        `Invalid IRI character U+${code.toString(16).toUpperCase().padStart(4, '0')} in ${context}: ${JSON.stringify(iri)}`,
      );
    }
  }
}

export function predicateIri(predicate: string): string {
  const iri = `${SG_PREDICATE_PREFIX}${predicate.replaceAll(':', '-')}`;
  assertValidIri(iri, 'predicate');
  return iri;
}

export function propertyIri(property: string): string {
  const iri = `${SG_PROPERTY_PREFIX}${property}`;
  assertValidIri(iri, 'property');
  return iri;
}

export function entityTypeIri(entityType: string): string {
  const iri = `${SG_ENTITY_TYPE_PREFIX}${entityType}`;
  assertValidIri(iri, 'entity type');
  return iri;
}

export function escapeLiteral(value: string): string {
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

export function literalTerm(value: unknown): string {
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
 * Literal encoding for the SHACL validation dataset. Identical to
 * `literalTerm` for primitives; nested structures carry SG_JSON_DATATYPE so
 * `sh:datatype xsd:string` cannot spuriously match them.
 */
export function validationLiteralTerm(value: unknown): string {
  if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return literalTerm(value);
  }
  return `"${escapeLiteral(canonicalJsonString(value))}"^^<${SG_JSON_DATATYPE}>`;
}
