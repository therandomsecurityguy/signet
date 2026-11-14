/**
 * Canonical JSON serialization for publication envelopes and governance events.
 *
 * `canonicalJsonString` implements RFC 8785 (JSON Canonicalization Scheme, JCS):
 * - object keys sorted by UTF-16 code units (ECMAScript default string sort)
 * - numbers serialized with the ECMAScript Number::toString algorithm
 *   (identical to JSON.stringify number output, including `-0` -> `0`)
 * - strings serialized with JSON.stringify escaping (minimal escaping,
 *   non-ASCII emitted literally)
 * - no insignificant whitespace
 *
 * `legacyCanonicalJsonString` preserves the pre-JCS key-sorted serialization
 * (localeCompare key ordering) so that publication envelopes created before
 * the JCS migration remain re-derivable and verifiable. The algorithm used
 * for a given publication is recorded on the version property
 * `canonicalization_algorithm`.
 */

export const JCS_CANONICALIZATION_ALGORITHM = 'jcs-rfc8785';
export const LEGACY_CANONICALIZATION_ALGORITHM = 'json-key-sort-v1';

export type CanonicalizationAlgorithm =
  | typeof JCS_CANONICALIZATION_ALGORITHM
  | typeof LEGACY_CANONICALIZATION_ALGORITHM;

export function canonicalJsonString(value: unknown): string {
  return serializeJcs(value);
}

function serializeJcs(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('JCS cannot serialize non-finite numbers.');
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => serializeJcs(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${serializeJcs(record[key])}`);
    return `{${entries.join(',')}}`;
  }
  throw new TypeError(`JCS cannot serialize values of type ${typeof value}.`);
}

export function legacyCanonicalJsonString(value: unknown): string {
  return JSON.stringify(sortLegacyJsonValue(value));
}

function sortLegacyJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortLegacyJsonValue(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortLegacyJsonValue(child)]),
    );
  }
  return value;
}

export function canonicalizeWith(algorithm: CanonicalizationAlgorithm, value: unknown): string {
  return algorithm === JCS_CANONICALIZATION_ALGORITHM
    ? canonicalJsonString(value)
    : legacyCanonicalJsonString(value);
}

export function resolveCanonicalizationAlgorithm(value: unknown): CanonicalizationAlgorithm {
  return value === JCS_CANONICALIZATION_ALGORITHM
    ? JCS_CANONICALIZATION_ALGORITHM
    : LEGACY_CANONICALIZATION_ALGORITHM;
}
