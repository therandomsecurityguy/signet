/**
 * Translation of the legacy JSON shape document (the registry's
 * "SHACL-like" policy format) into W3C SHACL Turtle for execution by a real
 * engine.
 *
 * Semantics preservation is the contract here — the parity test suite runs
 * the legacy reference engine and the W3C engine over the same graphs and
 * asserts identical violation tuples. To that end:
 *
 * - shapes are filtered to the focus entity type (the legacy engine skipped
 *   shapes whose target did not match the focus graph);
 * - targeting uses `sh:targetNode <focus_urn>` so validation only ever
 *   applies to the focus node (edge targets may themselves be versions and
 *   must never be validated incidentally);
 * - `datatype: "number"` becomes `sh:or(integer, double)` (and the result
 *   component is rewritten back to `DatatypeConstraintComponent`);
 * - `pattern` constraints are NOT emitted as `sh:pattern` — they are
 *   returned as specs for the RE2-owned pattern layer, because the engine
 *   executes `sh:pattern` with a backtracking RegExp (ReDoS-unsafe);
 * - messages are carried on the shape only when the policy author provided
 *   one; the result mapper computes the legacy fallback messages otherwise
 *   (the engine's built-in defaults do not match the legacy wording);
 * - non-primitive `in` entries are dropped: the legacy engine compared by
 *   JS identity, so such entries could never match a value.
 *
 * Property IRI encodings come from `sg-vocabulary.ts` — the same module the
 * (signed) canonical projection uses, so datasets cannot drift apart.
 */

import type {
  EdgeConstraint,
  NodeShape,
  PropertyConstraint,
  ShapeDocument,
  ShapeSeverity,
} from './shacl-like-validator.js';
import { escapeLiteral, entityTypeIri, literalTerm, predicateIri, propertyIri } from './sg-vocabulary.js';

const SHACL_NS = 'http://www.w3.org/ns/shacl#';
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
const XSD_DOUBLE = 'http://www.w3.org/2001/XMLSchema#double';

export type PatternSpec = {
  shape_id: string;
  shape_index: number;
  constraint_index: number;
  path: string;
  pattern: string;
  severity: ShapeSeverity;
  message: string;
};

export type ConstraintRef = {
  shape_id: string;
  shape_index: number;
  constraint_index: number;
  /** Original path (property key) or predicate, used as `resultPath`. */
  path: string;
  kind: 'property' | 'edge';
  severity: ShapeSeverity;
  /** Author-provided message, when present. */
  message?: string;
  constraint: PropertyConstraint | EdgeConstraint;
  /** How a `datatype` constraint was encoded; `or` results are reported as DatatypeConstraintComponent. */
  datatype_encoding?: 'direct' | 'or';
};

export type TranslatedShapes = {
  turtle: string;
  /** Property-shape IRI -> constraint metadata (sourceShape mapping + fallback messages). */
  constraintByShapeIri: Map<string, ConstraintRef>;
  /** RE2-owned pattern constraints (stripped from the turtle). */
  patterns: PatternSpec[];
  /** Number of shapes applicable to the requested entity type. */
  applicable_shape_count: number;
};

export class ShapeTranslationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShapeTranslationError';
  }
}

function shapeIri(shape: NodeShape, shapeIndex: number): string {
  // encodeURIComponent keeps the IRI legal for every author-settable shape
  // id (slashes, spaces, '#', ...) and is deterministic and reversible.
  return `urn:sg:shape:${encodeURIComponent(shape.id)}#s${shapeIndex}`;
}

function valueListTerm(value: unknown): string | null {
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return literalTerm(value);
  }
  return null;
}

function severityTerm(severity: ShapeSeverity | undefined): string | null {
  if (severity === undefined || severity === 'Violation') return null;
  return `<${SHACL_NS}${severity}>`;
}

export function translateShapeDocument(
  document: ShapeDocument,
  options: { focus_urn: string; entity_type: string },
): TranslatedShapes {
  const lines: string[] = [
    `@prefix sh: <${SHACL_NS}> .`,
    `@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .`,
    '',
  ];
  const constraintByShapeIri = new Map<string, ConstraintRef>();
  const patterns: PatternSpec[] = [];

  let shapeIndex = -1;
  let applicable = 0;
  for (const shape of document.shapes) {
    if (shape.target.entity_type !== options.entity_type) continue;
    shapeIndex += 1;
    applicable += 1;
    const nodeIri = shapeIri(shape, shapeIndex);

    const propertyShapeLines: string[] = [];
    const propertyShapes: string[] = [];
    let constraintIndex = -1;

    const emitConstraint = (ref: ConstraintRef, body: string[]): void => {
      constraintIndex += 1;
      ref.constraint_index = constraintIndex;
      const iri = `${nodeIri}c${constraintIndex}`;
      propertyShapes.push(`<${iri}>`);
      propertyShapeLines.push(`<${iri}> ${body.join(' ;\n    ')} .`);
      constraintByShapeIri.set(iri, ref);
    };

    for (const constraint of shape.properties ?? []) {
      const ref: ConstraintRef = {
        shape_id: shape.id,
        shape_index: shapeIndex,
        constraint_index: 0,
        path: constraint.path,
        kind: 'property',
        severity: constraint.severity ?? 'Violation',
        ...(constraint.message ? { message: constraint.message } : {}),
        constraint,
      };
      const body: string[] = [`sh:path <${propertyIri(constraint.path)}>`];
      if (constraint.minCount !== undefined) body.push(`sh:minCount ${constraint.minCount}`);
      if (constraint.maxCount !== undefined) body.push(`sh:maxCount ${constraint.maxCount}`);
      if (constraint.datatype === 'string') body.push(`sh:datatype xsd:string`);
      else if (constraint.datatype === 'integer') body.push(`sh:datatype xsd:integer`);
      else if (constraint.datatype === 'boolean') body.push(`sh:datatype xsd:boolean`);
      else if (constraint.datatype === 'number') {
        ref.datatype_encoding = 'or';
        body.push(
          `sh:or ( [ sh:datatype <${XSD_INTEGER}> ] [ sh:datatype <${XSD_DOUBLE}> ] )`,
        );
      }
      if (constraint.in) {
        // Non-primitive entries could never match under the legacy
        // identity comparison and are deliberately dropped.
        const terms = constraint.in.map(valueListTerm).filter((term): term is string => term !== null);
        body.push(`sh:in ( ${terms.join(' ')} )`);
      }
      if (ref.message) body.push(`sh:message "${escapeLiteral(ref.message)}"`);
      const severity = severityTerm(constraint.severity);
      if (severity) body.push(`sh:severity ${severity}`);
      emitConstraint(ref, body);
      if (constraint.pattern) {
        // Recorded for the RE2 pattern layer, never emitted as sh:pattern:
        // engines execute sh:pattern with a backtracking RegExp, which is
        // ReDoS-unsafe; the registry's RE2 layer keeps linear-time semantics.
        patterns.push({
          shape_id: shape.id,
          shape_index: ref.shape_index,
          constraint_index: ref.constraint_index,
          path: constraint.path,
          pattern: constraint.pattern,
          severity: ref.severity,
          message: ref.message ?? `value for ${constraint.path} must match pattern ${constraint.pattern}`,
        });
      }
    }

    for (const constraint of shape.edges ?? []) {
      const ref: ConstraintRef = {
        shape_id: shape.id,
        shape_index: shapeIndex,
        constraint_index: 0,
        path: constraint.predicate,
        kind: 'edge',
        severity: constraint.severity ?? 'Violation',
        ...(constraint.message ? { message: constraint.message } : {}),
        constraint,
      };
      const body: string[] = [`sh:path <${predicateIri(constraint.predicate)}>`];
      if (constraint.minCount !== undefined) body.push(`sh:minCount ${constraint.minCount}`);
      if (constraint.maxCount !== undefined) body.push(`sh:maxCount ${constraint.maxCount}`);
      if (constraint.to_entity_type) body.push(`sh:class <${entityTypeIri(constraint.to_entity_type)}>`);
      if (ref.message) body.push(`sh:message "${escapeLiteral(ref.message)}"`);
      const severity = severityTerm(constraint.severity);
      if (severity) body.push(`sh:severity ${severity}`);
      emitConstraint(ref, body);
    }

    lines.push(`<${nodeIri}> a sh:NodeShape ;`);
    if (propertyShapes.length > 0) {
      lines.push(`    sh:targetNode <${options.focus_urn}> ;`);
      lines.push(`    sh:property ${propertyShapes.join(` ;\n    sh:property `)} .`);
    } else {
      lines.push(`    sh:targetNode <${options.focus_urn}> .`);
    }
    lines.push('');
    lines.push(...propertyShapeLines);
    lines.push('');
  }

  return {
    turtle: lines.join('\n'),
    constraintByShapeIri,
    patterns,
    applicable_shape_count: applicable,
  };
}
