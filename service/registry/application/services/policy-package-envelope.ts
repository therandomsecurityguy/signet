/**
 * Policy package envelope parsing (storage format).
 *
 * Two envelope shapes share one CAS storage scheme
 * (`policy-packages/<version>.json`, canonical JSON):
 *
 * - legacy: `{ policy_version, shapes: <JSON shape document> }` — gates
 *   (`require_*`) live inside the shape document. Byte format is frozen;
 *   existing artifacts must keep content-addressing to the same sha256.
 * - authored Turtle: `{ policy_version, shapes_format: "shacl-turtle",
 *   shapes: "<turtle source>", require_*: ... }` — gates live at envelope
 *   top level because SHACL shapes have no place for lifecycle gates.
 *
 * `parsePolicyPackageEnvelope` is strict (throws) and used at registration;
 * reads wrap it and treat parse failures as "no policy bound", mirroring
 * the pre-existing behavior for malformed stored documents.
 */

import { parseShapeDocument, ShapeDocumentError, type ShapeDocument } from './shacl-like-validator.js';
import { parseTurtlePolicyShapes, TurtlePolicyError } from './shacl-turtle-policy.js';

export type PolicyShapesFormat = 'legacy-json-v1' | 'shacl-turtle';

export type PolicyGateFields = {
  require_human_review?: boolean;
  require_validation?: boolean;
  require_signature?: boolean;
  require_trusted_publisher?: boolean;
  require_build_provenance?: boolean;
  require_sbom?: boolean;
};

export const POLICY_GATE_FIELDS = [
  'require_human_review',
  'require_validation',
  'require_signature',
  'require_trusted_publisher',
  'require_build_provenance',
  'require_sbom',
] as const satisfies ReadonlyArray<keyof PolicyGateFields>;

export type ParsedPolicyPackageEnvelope = {
  shapes_format: PolicyShapesFormat;
  /** legacy: validated shape document; turtle: raw Turtle source. */
  shapes: unknown;
  /** Parsed document for legacy validation; null for Turtle envelopes. */
  document: ShapeDocument | null;
  /** Raw Turtle for authored-shape execution; null for legacy envelopes. */
  shapes_turtle: string | null;
  gates: PolicyGateFields;
};

export function parsePolicyPackageEnvelope(raw: unknown): ParsedPolicyPackageEnvelope {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ShapeDocumentError('Policy package envelope must be a JSON object.');
  }
  const record = raw as Record<string, unknown>;
  const format = record['shapes_format'];

  if (format === 'shacl-turtle') {
    const shapes = record['shapes'];
    if (typeof shapes !== 'string' || shapes.length === 0) {
      throw new TurtlePolicyError('shacl-turtle policy packages require a non-empty shapes Turtle string.');
    }
    parseTurtlePolicyShapes(shapes);
    const gates: PolicyGateFields = {};
    for (const field of POLICY_GATE_FIELDS) {
      const value = record[field];
      if (value !== undefined && typeof value !== 'boolean') {
        throw new ShapeDocumentError(`Policy package ${field} must be a boolean.`);
      }
      if (typeof value === 'boolean') {
        gates[field] = value;
      }
    }
    return { shapes_format: 'shacl-turtle', shapes, document: null, shapes_turtle: shapes, gates };
  }

  if (format !== undefined && format !== 'legacy-json-v1') {
    throw new ShapeDocumentError(`Unsupported policy package shapes_format: ${String(format)}`);
  }

  const document = parseShapeDocument(record['shapes']);
  const gates: PolicyGateFields = {};
  for (const field of POLICY_GATE_FIELDS) {
    if (typeof document[field] === 'boolean') {
      gates[field] = document[field];
    }
  }
  return { shapes_format: 'legacy-json-v1', shapes: document, document, shapes_turtle: null, gates };
}
