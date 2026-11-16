/**
 * Legacy "SHACL-like" validator: shape-document parsing, the shared
 * violation vocabulary, and the built-in graph shape.
 *
 * Production validation no longer executes here: shape documents are
 * translated to W3C SHACL Turtle and run by a real engine
 * (`shacl-publication-validation.ts`). This module is retained as:
 * - the parser/type home for the legacy JSON shape document format (still
 *   accepted for policy packages);
 * - the home of `BUILTIN_GRAPH_SHAPE_DOCUMENT`;
 * - the frozen reference engine for the parity test suite, which asserts
 *   the W3C engine reproduces these exact violation tuples.
 *
 * Subset semantics (unchanged): node shapes target version entities by
 * `entity_type`; property constraints minCount, maxCount, datatype, in,
 * pattern; edge constraints predicate presence/cardinality + target entity
 * type; violations use the SHACL result vocabulary (focusNode, resultPath,
 * sourceConstraintComponent, sourceShape, message, severity).
 *
 * Only `Violation`-severity results fail validation; `Warning` and `Info`
 * are evidence-only.
 *
 * Security: `pattern` constraints are executed with RE2 (via re2js), a
 * linear-time regular-expression engine with no backtracking, so even
 * catastrophic patterns such as (a+)+$ cannot stall the validator (ReDoS
 * safe by construction). Perl-only features RE2 does not support
 * (backreferences, lookarounds) are rejected at registration time. The W3C
 * path preserves this: `sh:pattern` is stripped from shapes and evaluated
 * by the same RE2 layer (see shacl-shape-translation.ts).
 */

import { RE2JS } from 're2js';

export type ShapeSeverity = 'Violation' | 'Warning' | 'Info';

export type PropertyConstraint = {
  path: string;
  minCount?: number;
  maxCount?: number;
  datatype?: 'string' | 'integer' | 'number' | 'boolean';
  in?: unknown[];
  pattern?: string;
  message?: string;
  severity?: ShapeSeverity;
};

export type EdgeConstraint = {
  predicate: string;
  minCount?: number;
  maxCount?: number;
  to_entity_type?: string;
  message?: string;
  severity?: ShapeSeverity;
};

export type NodeShape = {
  id: string;
  target: { entity_type: string };
  properties?: PropertyConstraint[];
  edges?: EdgeConstraint[];
};

export type ShapeDocument = {
  shapes: NodeShape[];
  /**
   * Policy-level gate: when true, publish and certify transitions for
   * versions bound to this policy require an approved human review.
   */
  require_human_review?: boolean;
  /**
   * Policy-level gates. Evidence-backed gates (signature, trusted publisher,
   * build provenance, SBOM) bind at certification, where the frozen envelope
   * is serveable and post-publish evidence exists; require_validation also
   * binds at publish.
   */
  require_validation?: boolean;
  require_signature?: boolean;
  require_trusted_publisher?: boolean;
  require_build_provenance?: boolean;
  require_sbom?: boolean;
};

export type ValidationViolation = {
  focusNode: string;
  resultPath?: string;
  sourceConstraintComponent: string;
  sourceShape: string;
  message: string;
  severity: ShapeSeverity;
};

export type ValidationDataGraph = {
  focus_urn: string;
  entity_type: string;
  properties: Record<string, unknown>;
  edges: Array<{ predicate: string; to_urn: string; to_entity_type?: string }>;
};

export class ShapeDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShapeDocumentError';
  }
}

export function parseShapeDocument(raw: unknown): ShapeDocument {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ShapeDocumentError('Shape document must be a JSON object.');
  }
  const shapes = (raw as Record<string, unknown>)['shapes'];
  if (!Array.isArray(shapes) || shapes.length === 0) {
    throw new ShapeDocumentError('Shape document must contain a non-empty shapes array.');
  }
  const requireHumanReview = (raw as Record<string, unknown>)['require_human_review'];
  if (requireHumanReview !== undefined && typeof requireHumanReview !== 'boolean') {
    throw new ShapeDocumentError('Shape document require_human_review must be a boolean.');
  }
  const booleanGates = [
    'require_validation',
    'require_signature',
    'require_trusted_publisher',
    'require_build_provenance',
    'require_sbom',
  ] as const;
  const parsedGates: Partial<Record<(typeof booleanGates)[number], boolean>> = {};
  for (const gate of booleanGates) {
    const value = (raw as Record<string, unknown>)[gate];
    if (value !== undefined && typeof value !== 'boolean') {
      throw new ShapeDocumentError(`Shape document ${gate} must be a boolean.`);
    }
    if (typeof value === 'boolean') {
      parsedGates[gate] = value;
    }
  }
  return {
    shapes: shapes.map((shape, index) => parseNodeShape(shape, index)),
    ...(typeof requireHumanReview === 'boolean' ? { require_human_review: requireHumanReview } : {}),
    ...parsedGates,
  };
}

function parseNodeShape(raw: unknown, index: number): NodeShape {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ShapeDocumentError(`Shape at index ${index} must be an object.`);
  }
  const record = raw as Record<string, unknown>;
  const id = record['id'];
  if (typeof id !== 'string' || id.length === 0) {
    throw new ShapeDocumentError(`Shape at index ${index} requires a non-empty string id.`);
  }
  const target = record['target'];
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    throw new ShapeDocumentError(`Shape ${id} requires a target object.`);
  }
  const entityType = (target as Record<string, unknown>)['entity_type'];
  if (typeof entityType !== 'string' || entityType.length === 0) {
    throw new ShapeDocumentError(`Shape ${id} target requires a non-empty entity_type.`);
  }
  const properties = record['properties'];
  if (properties !== undefined && !Array.isArray(properties)) {
    throw new ShapeDocumentError(`Shape ${id} properties must be an array.`);
  }
  const edges = record['edges'];
  if (edges !== undefined && !Array.isArray(edges)) {
    throw new ShapeDocumentError(`Shape ${id} edges must be an array.`);
  }
  return {
    id,
    target: { entity_type: entityType },
    ...(properties ? { properties: properties.map((p, i) => parsePropertyConstraint(id, p, i)) } : {}),
    ...(edges ? { edges: edges.map((e, i) => parseEdgeConstraint(id, e, i)) } : {}),
  };
}

function parsePropertyConstraint(shapeId: string, raw: unknown, index: number): PropertyConstraint {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ShapeDocumentError(`Shape ${shapeId} property constraint at index ${index} must be an object.`);
  }
  const record = raw as Record<string, unknown>;
  const path = record['path'];
  if (typeof path !== 'string' || path.length === 0) {
    throw new ShapeDocumentError(`Shape ${shapeId} property constraint at index ${index} requires a non-empty path.`);
  }
  assertOptionalCount(shapeId, record, 'minCount');
  assertOptionalCount(shapeId, record, 'maxCount');
  const datatype = record['datatype'];
  if (datatype !== undefined && datatype !== 'string' && datatype !== 'integer' && datatype !== 'number' && datatype !== 'boolean') {
    throw new ShapeDocumentError(`Shape ${shapeId} path ${path} has unsupported datatype ${String(datatype)}.`);
  }
  const inValues = record['in'];
  if (inValues !== undefined && !Array.isArray(inValues)) {
    throw new ShapeDocumentError(`Shape ${shapeId} path ${path} in must be an array.`);
  }
  const pattern = record['pattern'];
  if (pattern !== undefined) {
    if (typeof pattern !== 'string') {
      throw new ShapeDocumentError(`Shape ${shapeId} path ${path} pattern must be a string.`);
    }
    try {
      RE2JS.compile(pattern);
    } catch {
      throw new ShapeDocumentError(
        `Shape ${shapeId} path ${path} pattern is not a valid RE2 regular expression (backreferences and lookarounds are unsupported).`,
      );
    }
  }
  return {
    path,
    ...(typeof record['minCount'] === 'number' ? { minCount: record['minCount'] } : {}),
    ...(typeof record['maxCount'] === 'number' ? { maxCount: record['maxCount'] } : {}),
    ...(datatype ? { datatype: datatype as NonNullable<PropertyConstraint['datatype']> } : {}),
    ...(inValues ? { in: inValues } : {}),
    ...(typeof pattern === 'string' ? { pattern } : {}),
    ...(typeof record['message'] === 'string' ? { message: record['message'] } : {}),
    ...(isSeverity(record['severity']) ? { severity: record['severity'] } : {}),
  };
}

function parseEdgeConstraint(shapeId: string, raw: unknown, index: number): EdgeConstraint {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ShapeDocumentError(`Shape ${shapeId} edge constraint at index ${index} must be an object.`);
  }
  const record = raw as Record<string, unknown>;
  const predicate = record['predicate'];
  if (typeof predicate !== 'string' || predicate.length === 0) {
    throw new ShapeDocumentError(`Shape ${shapeId} edge constraint at index ${index} requires a non-empty predicate.`);
  }
  assertOptionalCount(shapeId, record, 'minCount');
  assertOptionalCount(shapeId, record, 'maxCount');
  return {
    predicate,
    ...(typeof record['minCount'] === 'number' ? { minCount: record['minCount'] } : {}),
    ...(typeof record['maxCount'] === 'number' ? { maxCount: record['maxCount'] } : {}),
    ...(typeof record['to_entity_type'] === 'string' ? { to_entity_type: record['to_entity_type'] } : {}),
    ...(typeof record['message'] === 'string' ? { message: record['message'] } : {}),
    ...(isSeverity(record['severity']) ? { severity: record['severity'] } : {}),
  };
}

function assertOptionalCount(shapeId: string, record: Record<string, unknown>, key: 'minCount' | 'maxCount') {
  const value = record[key];
  if (value !== undefined && (!Number.isInteger(value) || (value as number) < 0)) {
    throw new ShapeDocumentError(`Shape ${shapeId} ${key} must be a non-negative integer.`);
  }
}

function isSeverity(value: unknown): value is ShapeSeverity {
  return value === 'Violation' || value === 'Warning' || value === 'Info';
}

export function validateShapes(graph: ValidationDataGraph, document: ShapeDocument): ValidationViolation[] {
  const violations: ValidationViolation[] = [];
  for (const shape of document.shapes) {
    if (shape.target.entity_type !== graph.entity_type) continue;
    for (const constraint of shape.properties ?? []) {
      violations.push(...checkPropertyConstraint(graph, shape, constraint));
    }
    for (const constraint of shape.edges ?? []) {
      violations.push(...checkEdgeConstraint(graph, shape, constraint));
    }
  }
  return violations;
}

function valuesOf(properties: Record<string, unknown>, path: string): unknown[] {
  const value = properties[path];
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value.filter((item) => item !== undefined && item !== null) : [value];
}

function checkPropertyConstraint(
  graph: ValidationDataGraph,
  shape: NodeShape,
  constraint: PropertyConstraint,
): ValidationViolation[] {
  const violations: ValidationViolation[] = [];
  const values = valuesOf(graph.properties, constraint.path);
  const severity = constraint.severity ?? 'Violation';
  const emit = (component: string, fallback: string): void => {
    violations.push({
      focusNode: graph.focus_urn,
      resultPath: constraint.path,
      sourceConstraintComponent: component,
      sourceShape: shape.id,
      message: constraint.message ?? fallback,
      severity,
    });
  };

  if (constraint.minCount !== undefined && values.length < constraint.minCount) {
    emit('MinCountConstraintComponent', `requires at least ${constraint.minCount} value(s) for ${constraint.path}`);
  }
  if (constraint.maxCount !== undefined && values.length > constraint.maxCount) {
    emit('MaxCountConstraintComponent', `requires at most ${constraint.maxCount} value(s) for ${constraint.path}`);
  }
  const compiledPattern = constraint.pattern ? RE2JS.compile(constraint.pattern) : null;
  for (const value of values) {
    if (constraint.datatype && !matchesDatatype(value, constraint.datatype)) {
      emit('DatatypeConstraintComponent', `value for ${constraint.path} must be of datatype ${constraint.datatype}`);
    }
    if (constraint.in && !constraint.in.some((allowed) => allowed === value)) {
      emit('InConstraintComponent', `value for ${constraint.path} must be one of the allowed values`);
    }
    // RE2 find() is the partial-match equivalent of RegExp.test(), executed
    // in linear time with no backtracking.
    if (compiledPattern && typeof value === 'string' && !compiledPattern.matcher(value).find()) {
      emit('PatternConstraintComponent', `value for ${constraint.path} must match pattern ${constraint.pattern}`);
    }
  }
  return violations;
}

function checkEdgeConstraint(
  graph: ValidationDataGraph,
  shape: NodeShape,
  constraint: EdgeConstraint,
): ValidationViolation[] {
  const violations: ValidationViolation[] = [];
  const severity = constraint.severity ?? 'Violation';
  const matching = graph.edges.filter((edge) => edge.predicate === constraint.predicate);
  const emit = (component: string, fallback: string): void => {
    violations.push({
      focusNode: graph.focus_urn,
      resultPath: constraint.predicate,
      sourceConstraintComponent: component,
      sourceShape: shape.id,
      message: constraint.message ?? fallback,
      severity,
    });
  };

  if (constraint.minCount !== undefined && matching.length < constraint.minCount) {
    emit('MinCountConstraintComponent', `requires at least ${constraint.minCount} edge(s) with predicate ${constraint.predicate}`);
  }
  if (constraint.maxCount !== undefined && matching.length > constraint.maxCount) {
    emit('MaxCountConstraintComponent', `requires at most ${constraint.maxCount} edge(s) with predicate ${constraint.predicate}`);
  }
  if (constraint.to_entity_type) {
    for (const edge of matching) {
      if (edge.to_entity_type !== constraint.to_entity_type) {
        emit('ClassConstraintComponent', `edge ${constraint.predicate} must target entity type ${constraint.to_entity_type}`);
      }
    }
  }
  return violations;
}

function matchesDatatype(value: unknown, datatype: NonNullable<PropertyConstraint['datatype']>): boolean {
  switch (datatype) {
    case 'string':
      return typeof value === 'string';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
  }
}

/**
 * Built-in graph-shape layer: structural rules every publishable version
 * must satisfy before policy validation runs. Expressed as a shape
 * document so both layers share the same engine and report vocabulary.
 */
export const BUILTIN_GRAPH_SHAPE_DOCUMENT: ShapeDocument = {
  shapes: [
    {
      id: 'registry-graph-shape/skill-version',
      target: { entity_type: 'SKILL_VERSION' },
      properties: [
        { path: 'artifact_sha256', minCount: 1, message: 'missing_artifact_evidence' },
        { path: 'source_path', minCount: 1, message: 'missing_source_path_evidence' },
        { path: 'version', minCount: 1, datatype: 'integer', message: 'invalid_version_number' },
      ],
      edges: [
        {
          predicate: 'sg:implementedBy',
          minCount: 1,
          to_entity_type: 'ARTIFACT',
          message: 'missing_implementation_edge',
        },
      ],
    },
    {
      id: 'registry-graph-shape/agent-version',
      target: { entity_type: 'AGENT_VERSION' },
      properties: [
        { path: 'artifact_sha256', minCount: 1, message: 'missing_artifact_evidence' },
        { path: 'source_path', minCount: 1, message: 'missing_source_path_evidence' },
        { path: 'version', minCount: 1, datatype: 'integer', message: 'invalid_version_number' },
      ],
      edges: [
        {
          predicate: 'sg:definedBy',
          minCount: 1,
          to_entity_type: 'ARTIFACT',
          message: 'missing_definition_edge',
        },
      ],
    },
  ],
};
