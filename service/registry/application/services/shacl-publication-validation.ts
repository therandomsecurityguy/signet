/**
 * W3C SHACL publication-graph validation (orchestration).
 *
 * Replaces the bespoke "SHACL-like" engine on the production path: the
 * typed validation graph becomes an N-Quads dataset, the shape document is
 * translated to Turtle, a real SHACL engine executes it, and results are
 * mapped back to the registry's `ValidationViolation` vocabulary with
 * byte-level message/severity/component parity (asserted by the parity
 * test suite against the frozen legacy engine).
 *
 * Layer-specific behavior:
 * - `sh:pattern` never reaches the engine; pattern constraints execute in
 *   the registry's RE2-owned layer (linear time, ReDoS-safe by
 *   construction). The engine's backtracking RegExp would let an
 *   author-registered pattern stall validation on adversarial values.
 * - Shapes targeting an entity type other than the focus graph's are
 *   filtered out (the legacy engine skipped them) and targeting uses
 *   `sh:targetNode` so edge targets are never validated incidentally.
 * - Fallback messages replicate the legacy wording exactly; the engine's
 *   built-in messages are never surfaced.
 */

import { RE2JS } from 're2js';

import type {
  EdgeConstraint,
  PropertyConstraint,
  ShapeDocument,
  ValidationDataGraph,
  ValidationViolation,
} from './shacl-like-validator.js';
import { assertValidIri, entityTypeIri, predicateIri, propertyIri, validationLiteralTerm } from './sg-vocabulary.js';
import type { ConstraintRef } from './shacl-shape-translation.js';
import { translateShapeDocument } from './shacl-shape-translation.js';
import type { ShaclExecutionPort } from './shacl-execution-port.js';
import { createRdfValidateShaclEngine } from './rdf-validate-shacl-engine.js';

/** Recorded in validation report artifacts. */
export const SHACL_VALIDATOR_ID = 'shacl-v1';

const RDF_TYPE_IRI = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

let defaultEngine: ShaclExecutionPort | undefined;

/** Use an injected engine when provided (tests/custom); otherwise the
 * process-wide rdf-validate-shacl adapter. */
export function resolveShaclEngine(port?: ShaclExecutionPort): ShaclExecutionPort {
  if (port) return port;
  defaultEngine ??= createRdfValidateShaclEngine();
  return defaultEngine;
}

/**
 * Build the SHACL validation dataset: focus-node properties and edges from
 * the typed graph, plus `rdf:type` triples for the focus node and for edge
 * targets (so `sh:class` can check `to_entity_type`). Unsigned — the
 * RDFC-1.0 canonical projection used for semantic digests is a separate,
 * frozen encoding.
 *
 * Edge target types are derived from the target node (`graph.getNode`) by
 * the caller and are therefore consistent across edges pointing at the same
 * target; type triples are deduplicated accordingly. Legacy per-edge parity
 * relies on that invariant, which holds for every graph produced by
 * `runPublicationValidation`.
 */
export function buildValidationDatasetNQuads(graph: ValidationDataGraph): string[] {
  assertValidIri(graph.focus_urn, 'focus urn');
  const subject = `<${graph.focus_urn}>`;
  const lines: string[] = [
    `${subject} <${RDF_TYPE_IRI}> <${entityTypeIri(graph.entity_type)}> .`,
  ];

  for (const key of Object.keys(graph.properties).sort()) {
    const value = graph.properties[key];
    if (value === undefined || value === null) continue;
    const predicate = `<${propertyIri(key)}>`;
    if (Array.isArray(value)) {
      const items = value.filter((item) => item !== undefined && item !== null);
      const sorted = items.map((item) => validationLiteralTerm(item)).sort();
      for (const term of sorted) {
        lines.push(`${subject} ${predicate} ${term} .`);
      }
    } else {
      lines.push(`${subject} ${predicate} ${validationLiteralTerm(value)} .`);
    }
  }

  const edges = [...graph.edges].sort((left, right) =>
    left.predicate === right.predicate ? left.to_urn.localeCompare(right.to_urn) : left.predicate.localeCompare(right.predicate),
  );
  const typeLines = new Set<string>();
  for (const edge of edges) {
    assertValidIri(edge.to_urn, `edge target (${edge.predicate})`);
    lines.push(`${subject} <${predicateIri(edge.predicate)}> <${edge.to_urn}> .`);
    if (edge.to_entity_type) {
      typeLines.add(`<${edge.to_urn}> <${RDF_TYPE_IRI}> <${entityTypeIri(edge.to_entity_type)}> .`);
    }
  }
  lines.push(...[...typeLines].sort());
  return lines;
}

/** Mirrors the legacy engine's value extraction exactly. */
function valuesOf(properties: Record<string, unknown>, path: string): unknown[] {
  const value = properties[path];
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value.filter((item) => item !== undefined && item !== null) : [value];
}

/** Legacy fallback wording, replicated verbatim (pinned by parity tests). */
function legacyFallbackMessage(ref: ConstraintRef, component: string): string {
  if (ref.kind === 'property') {
    const constraint = ref.constraint as PropertyConstraint;
    switch (component) {
      case 'MinCountConstraintComponent':
        return `requires at least ${constraint.minCount} value(s) for ${ref.path}`;
      case 'MaxCountConstraintComponent':
        return `requires at most ${constraint.maxCount} value(s) for ${ref.path}`;
      case 'DatatypeConstraintComponent':
        return `value for ${ref.path} must be of datatype ${constraint.datatype}`;
      case 'InConstraintComponent':
        return `value for ${ref.path} must be one of the allowed values`;
      default:
        return `value for ${ref.path} is not valid`;
    }
  }
  const constraint = ref.constraint as EdgeConstraint;
  switch (component) {
    case 'MinCountConstraintComponent':
      return `requires at least ${constraint.minCount} edge(s) with predicate ${ref.path}`;
    case 'MaxCountConstraintComponent':
      return `requires at most ${constraint.maxCount} edge(s) with predicate ${ref.path}`;
    case 'ClassConstraintComponent':
      return `edge ${ref.path} must target entity type ${constraint.to_entity_type}`;
    default:
      return `edge ${ref.path} is not valid`;
  }
}

function normalizeComponent(ref: ConstraintRef, component: string): string {
  // `datatype: "number"` translates to sh:or(integer,double); report it
  // under the legacy component name.
  if (ref.datatype_encoding === 'or' && component === 'OrConstraintComponent') {
    return 'DatatypeConstraintComponent';
  }
  return component;
}

function componentRank(component: string): number {
  switch (component) {
    case 'DatatypeConstraintComponent':
      return 0;
    case 'InConstraintComponent':
      return 1;
    case 'ClassConstraintComponent':
      return 1;
    case 'PatternConstraintComponent':
      return 2;
    default:
      return 3;
  }
}

type RankedViolation = {
  shapeIndex: number;
  constraintIndex: number;
  valueGroup: number;
  value: string;
  rank: number;
  violation: ValidationViolation;
};

function compareRanked(left: RankedViolation, right: RankedViolation): number {
  if (left.shapeIndex !== right.shapeIndex) return left.shapeIndex - right.shapeIndex;
  if (left.constraintIndex !== right.constraintIndex) return left.constraintIndex - right.constraintIndex;
  if (left.valueGroup !== right.valueGroup) return left.valueGroup - right.valueGroup;
  if (left.value !== right.value) return left.value < right.value ? -1 : 1;
  return left.rank - right.rank;
}

/**
 * Validate one publication graph against a shape document with W3C SHACL.
 * Async: the engine parses datasets and executes asynchronously.
 */
export async function validatePublicationGraphWithShacl(
  input: { graph: ValidationDataGraph; document: ShapeDocument },
  engine?: ShaclExecutionPort,
): Promise<ValidationViolation[]> {
  const translated = translateShapeDocument(input.document, {
    focus_urn: input.graph.focus_urn,
    entity_type: input.graph.entity_type,
  });
  if (translated.applicable_shape_count === 0) return [];

  const dataset = buildValidationDatasetNQuads(input.graph);
  const report = await resolveShaclEngine(engine).validate({
    data_nquads: dataset.join('\n'),
    shapes_turtle: translated.turtle,
  });

  const ranked: RankedViolation[] = [];
  for (const result of report.results ?? []) {
    const ref = result.sourceShape ? translated.constraintByShapeIri.get(result.sourceShape) : undefined;
    if (!ref) continue; // results outside translated shapes never map to violations
    const component = normalizeComponent(ref, result.sourceConstraintComponent);
    ranked.push({
      shapeIndex: ref.shape_index,
      constraintIndex: ref.constraint_index,
      valueGroup: result.value ? 1 : 0,
      value: result.value ?? '',
      rank: componentRank(component),
      violation: {
        focusNode: input.graph.focus_urn,
        resultPath: ref.path,
        sourceConstraintComponent: component,
        sourceShape: ref.shape_id,
        message: ref.message ?? legacyFallbackMessage(ref, component),
        severity: ref.severity,
      },
    });
  }

  // RE2-owned pattern layer: linear-time execution for every author
  // pattern; string values only, mirroring the legacy engine.
  for (const spec of translated.patterns) {
    const compiled = RE2JS.compile(spec.pattern);
    for (const value of valuesOf(input.graph.properties, spec.path)) {
      if (typeof value !== 'string') continue;
      if (!compiled.matcher(value).find()) {
        ranked.push({
          shapeIndex: spec.shape_index,
          constraintIndex: spec.constraint_index,
          valueGroup: 1,
          value,
          rank: componentRank('PatternConstraintComponent'),
          violation: {
            focusNode: input.graph.focus_urn,
            resultPath: spec.path,
            sourceConstraintComponent: 'PatternConstraintComponent',
            sourceShape: spec.shape_id,
            message: spec.message,
            severity: spec.severity,
          },
        });
      }
    }
  }

  ranked.sort(compareRanked);
  return ranked.map((entry) => entry.violation);
}
