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

import { DataFactory, Parser, Store, Writer } from 'n3';
import { RE2JS } from 're2js';

import type {
  EdgeConstraint,
  PropertyConstraint,
  ShapeDocument,
  ShapeSeverity,
  ValidationDataGraph,
  ValidationViolation,
} from './shacl-like-validator.js';
import {
  assertValidIri,
  entityTypeIri,
  predicateIri,
  propertyIri,
  validationLiteralTerm,
  SG_PREDICATE_PREFIX,
  SG_PROPERTY_PREFIX,
} from './sg-vocabulary.js';
import type { ConstraintRef } from './shacl-shape-translation.js';
import { translateShapeDocument } from './shacl-shape-translation.js';
import type { ShaclExecutionPort } from './shacl-execution-port.js';
import { createRdfValidateShaclEngine } from './rdf-validate-shacl-engine.js';
import { createShaclEngineSparqlAdapter } from './shacl-engine-sparql-engine.js';

/** Recorded in validation report artifacts. */
export const SHACL_VALIDATOR_ID = 'shacl-v1';

const SHACL_NS = 'http://www.w3.org/ns/shacl#';

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
 * Engine selection for authored Turtle shapes: SPARQL features
 * (sh:sparql constraints or SPARQL-based targets) require the shacl-engine
 * hybrid adapter; everything else stays on the default core engine. An
 * injected engine always wins (tests/deployments).
 */
export async function resolveTurtleShapesEngine(
  shapesTurtle: string,
  injected?: ShaclExecutionPort,
): Promise<ShaclExecutionPort> {
  if (injected) return injected;
  let usesSparql = false;
  try {
    const store = new Store(new Parser({ format: 'text/turtle' }).parse(shapesTurtle));
    const sparqlPredicate = DataFactory.namedNode(`${SHACL_NS}sparql`);
    const targetPredicate = DataFactory.namedNode(`${SHACL_NS}target`);
    const selectPredicate = DataFactory.namedNode(`${SHACL_NS}select`);
    usesSparql =
      store.getQuads(null, sparqlPredicate, null, null).length > 0 ||
      store
        .getQuads(null, targetPredicate, null, null)
        .some((targetQuad) => store.getQuads(targetQuad.object, selectPredicate, null, null).length > 0);
  } catch {
    usesSparql = false; // unparseable shapes fail later in preparation
  }
  return usesSparql ? await createShaclEngineSparqlAdapter() : resolveShaclEngine(undefined);
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

// Blank-node labels from engines are run-dependent (e.g. b1_n3-1): label
// anonymous property shapes deterministically from their path instead.
const IRI_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

function stableSourceShape(rawSourceShape: string | undefined, path: string | undefined): string {
  const candidate = rawSourceShape?.replace(/^_:/, '');
  if (candidate && IRI_SCHEME_RE.test(candidate)) return candidate;
  return path ? `anonymous:${path}` : 'anonymous-shape';
}

function normalizeSeverity(value: string | undefined): ShapeSeverity {
  return value === 'Violation' || value === 'Warning' || value === 'Info' ? value : 'Violation';
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

// ---------------------------------------------------------------------------
// Authored-Turtle policies
// ---------------------------------------------------------------------------

export type TurtlePatternSpec = {
  source_shape: string;
  path_iri: string;
  pattern: string;
  severity: ShapeSeverity;
  message: string;
};

/**
 * Prepare authored policy Turtle for one focus publication:
 * - every `sh:targetClass` triple is removed; shapes whose target matches
 *   the focus entity type get `sh:targetNode <focus_urn>` injected, other
 *   shapes become inert (the legacy engine skipped non-matching shapes);
 *   explicit node targeting is rejected at registration, so no shape can
 *   validate anything other than the focus node — edge targets that happen
 *   to share the focus entity type are never validated incidentally;
 * - `sh:pattern` triples are stripped and returned as RE2 specs (the
 *   registry's pattern layer keeps execution linear-time).
 */
async function prepareAuthoredTurtle(
  shapesTurtle: string,
  focus: { focus_urn: string; entity_type: string },
): Promise<{ shapes_nquads: string; pattern_specs: TurtlePatternSpec[] }> {
  const store = new Store(new Parser({ format: 'text/turtle' }).parse(shapesTurtle));
  const factory = DataFactory;
  const targetClass = factory.namedNode(`${SHACL_NS}targetClass`);
  const targetNode = factory.namedNode(`${SHACL_NS}targetNode`);
  const pathPredicate = factory.namedNode(`${SHACL_NS}path`);
  const patternPredicate = factory.namedNode(`${SHACL_NS}pattern`);
  const messagePredicate = factory.namedNode(`${SHACL_NS}message`);
  const severityPredicate = factory.namedNode(`${SHACL_NS}severity`);
  const focusType = entityTypeIri(focus.entity_type);

  for (const quad of [...store.getQuads(null, targetClass, null, null)]) {
    store.removeQuad(quad);
    if (quad.object.termType === 'NamedNode' && quad.object.value === focusType) {
      store.addQuad(quad.subject, targetNode, factory.namedNode(focus.focus_urn));
    }
  }

  const patternSpecs: TurtlePatternSpec[] = [];
  for (const quad of [...store.getQuads(null, patternPredicate, null, null)]) {
    const paths = store.getQuads(quad.subject, pathPredicate, null, null);
    const messageQuad = store.getQuads(quad.subject, messagePredicate, null, null)[0];
    const severityQuad = store.getQuads(quad.subject, severityPredicate, null, null)[0];
    store.removeQuad(quad);
    for (const pathQuad of paths) {
      if (pathQuad.object.termType !== 'NamedNode') continue; // rejected at registration
      patternSpecs.push({
        source_shape: quad.subject.termType === 'BlankNode' ? `anonymous:${pathQuad.object.value}` : quad.subject.value,
        path_iri: pathQuad.object.value,
        pattern: quad.object.value,
        severity: normalizeSeverity(severityQuad?.object.value.replace(SHACL_NS, '')),
        message: messageQuad?.object.value ?? `value for ${pathQuad.object.value} must match pattern ${quad.object.value}`,
      });
    }
  }

  const writer = new Writer({ format: 'application/n-quads' });
  writer.addQuads(store.getQuads(null, null, null, null));
  const shapesNQuads = await new Promise<string>((resolve, reject) => {
    writer.end((error, result) => (error ? reject(error) : resolve(String(result))));
  });

  return { shapes_nquads: shapesNQuads, pattern_specs: patternSpecs };
}

function turtlePathValues(graph: ValidationDataGraph, pathIri: string): unknown[] {
  if (pathIri.startsWith(SG_PROPERTY_PREFIX)) {
    return valuesOf(graph.properties, pathIri.slice(SG_PROPERTY_PREFIX.length));
  }
  if (pathIri.startsWith(SG_PREDICATE_PREFIX)) {
    return graph.edges.filter((edge) => predicateIri(edge.predicate) === pathIri).map((edge) => edge.to_urn);
  }
  return [];
}

/**
 * Validate one publication graph against authored W3C SHACL Turtle (policy
 * packages with `shapes_format: "shacl-turtle"`, and the built-in graph
 * shape). Results pass through engine vocabulary directly: result paths are
 * the authored IRIs, messages come from `sh:message` or the engine default,
 * and ordering is deterministic. This path is deliberately independent of
 * the legacy-result mapping (no legacy fallback wording).
 */
export async function validatePublicationGraphWithTurtleShapes(
  input: { graph: ValidationDataGraph; shapes_turtle: string },
  engine?: ShaclExecutionPort,
): Promise<ValidationViolation[]> {
  const translated = await prepareAuthoredTurtle(input.shapes_turtle, {
    focus_urn: input.graph.focus_urn,
    entity_type: input.graph.entity_type,
  });
  // SPARQL-feature shapes need shacl-engine (with its SPARQL plugin loaded);
  // everything else stays on the default rdf-validate-shacl engine. An
  // injected engine (tests/deployments) always wins.
  const activeEngine = await resolveTurtleShapesEngine(input.shapes_turtle, engine);
  const report = await activeEngine.validate({
    data_nquads: buildValidationDatasetNQuads(input.graph).join('\n'),
    shapes_turtle: translated.shapes_nquads,
  });

  const mapped: Array<{ key: string; violation: ValidationViolation }> = [];
  for (const result of report.results ?? []) {
    // Focus-scoped by construction: SPARQL-based targets can select other
    // nodes in the dataset (e.g. version-to-version edge targets sharing the
    // focus entity type); only the focus publication is ever validated.
    if (result.focusNode !== input.graph.focus_urn) continue;
    const path = result.path;
    const sourceShape = stableSourceShape(result.sourceShape, path);
    mapped.push({
      key: JSON.stringify([path ?? '', sourceShape, result.message ?? '']),
      violation: {
        focusNode: input.graph.focus_urn,
        ...(path ? { resultPath: path } : {}),
        sourceConstraintComponent: result.sourceConstraintComponent,
        sourceShape,
        message: result.message ?? result.sourceConstraintComponent,
        severity: normalizeSeverity(result.severity),
      },
    });
  }

  for (const spec of translated.pattern_specs) {
    const compiled = RE2JS.compile(spec.pattern);
    for (const value of turtlePathValues(input.graph, spec.path_iri)) {
      if (typeof value !== 'string') continue;
      if (!compiled.matcher(value).find()) {
        mapped.push({
          key: JSON.stringify([spec.path_iri, spec.source_shape, spec.message, value]),
          violation: {
            focusNode: input.graph.focus_urn,
            resultPath: spec.path_iri,
            sourceConstraintComponent: 'PatternConstraintComponent',
            sourceShape: spec.source_shape,
            message: spec.message,
            severity: spec.severity,
          },
        });
      }
    }
  }

  mapped.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  return mapped.map((entry) => entry.violation);
}
