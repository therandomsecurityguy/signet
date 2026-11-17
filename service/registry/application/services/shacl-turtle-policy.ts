/**
 * Authored-Turtle policy shapes: registration-time parsing and validation.
 *
 * Policies can be registered as W3C SHACL Turtle instead of the legacy JSON
 * shape document. Registration enforces the registry's authoring
 * conventions (v1) so execution-time translation is deterministic and
 * safe:
 *
 * - shapes target publications with `sh:targetClass` over the registry's
 *   entity-type IRIs (`urn:sg:entity-type:<TYPE>`); explicit node targeting
 *   (`sh:targetNode`, `sh:targetObjectsOf`, `sh:targetSubjectsOf`) is
 *   rejected — the validator injects `sh:targetNode` for the focus
 *   publication so edge targets are never validated incidentally;
 * - `sh:path` must be a simple property (`urn:sg:property:*`) or predicate
 *   (`urn:sg:predicate:*`) IRI;
 * - `sh:pattern` is accepted but executed by the registry's RE2 layer
 *   (backtracking JS RegExp engines are ReDoS-unsafe): the pattern is
 *   compiled with RE2 at registration so invalid or Perl-only syntax is
 *   rejected before the policy is stored, and stripped from the shapes
 *   before engine execution.
 */

import { Parser, Store, type Term } from 'n3';
import { RE2JS } from 're2js';

import { SG_PREDICATE_PREFIX, SG_PROPERTY_PREFIX } from './sg-vocabulary.js';

const SHACL_NS = 'http://www.w3.org/ns/shacl#';

const TARGET_CLASS = `${SHACL_NS}targetClass`;
const TARGET_NODE = `${SHACL_NS}targetNode`;
const TARGET_OBJECTS_OF = `${SHACL_NS}targetObjectsOf`;
const TARGET_SUBJECTS_OF = `${SHACL_NS}targetSubjectsOf`;
const PATH = `${SHACL_NS}path`;
const PATTERN = `${SHACL_NS}pattern`;
const SPARQL = `${SHACL_NS}sparql`;
const SELECT = `${SHACL_NS}select`;
const PREFIXES = `${SHACL_NS}prefixes`;
const DECLARE = `${SHACL_NS}declare`;
const DECLARE_PREFIX = `${SHACL_NS}prefix`;
const DECLARE_NAMESPACE = `${SHACL_NS}namespace`;
const PROPERTY = `${SHACL_NS}property`;
const TARGET = `${SHACL_NS}target`;
const ANY_URI = 'http://www.w3.org/2001/XMLSchema#anyURI';

/**
 * SHACL-AF features this engine does not execute. Silent non-execution
 * would read as "conforms" — never acceptable for a governance gate — so
 * these are rejected at registration with an explicit reason.
 */
const UNEXECUTED_FEATURES: Array<{ predicate: string; label: string }> = [
  { predicate: `${SHACL_NS}rule`, label: 'sh:rule (SHACL-AF rules)' },
  { predicate: `${SHACL_NS}function`, label: 'sh:function (SHACL-AF functions)' },
  { predicate: `${SHACL_NS}js`, label: 'sh:js (JavaScript-based constraints)' },
];

function assertSparqlSelectSafe(selectText: string, context: string): void {
  if (selectText.trim().length === 0) {
    throw new TurtlePolicyError(`${context} sh:select must be a non-empty string.`);
  }
  // The SPARQL-capable engine evaluates REGEX() with a backtracking XPath
  // regex — the same ReDoS class deliberately banned from sh:pattern (which
  // stays RE2-owned). Regex work belongs in sh:pattern.
  if (/REGEX\s*\(/i.test(selectText)) {
    throw new TurtlePolicyError(
      `${context} uses REGEX() in SPARQL: the engine executes it with a backtracking regex (ReDoS-unsafe). Use the RE2-backed sh:pattern constraint for regex checks.`,
    );
  }
}

function validateSparqlBlock(store: Store, block: Term, context: string): void {
  const selects = store.getQuads(block, SELECT, null, null);
  const selectQuads = selects.filter((quad) => quad.object.termType === 'Literal');
  if (selectQuads.length === 0) {
    throw new TurtlePolicyError(`${context} requires a sh:select string.`);
  }
  for (const selectQuad of selectQuads) {
    assertSparqlSelectSafe(selectQuad.object.value, context);
  }
  for (const prefixesQuad of store.getQuads(block, PREFIXES, null, null)) {
    const declarations = store.getQuads(prefixesQuad.object, DECLARE, null, null);
    if (declarations.length === 0) {
      throw new TurtlePolicyError(
        `${context} sh:prefixes must reference a node with sh:declare [ sh:prefix ... ; sh:namespace ... ] declarations.`,
      );
    }
    for (const declaration of declarations) {
      const prefixQuad = store.getQuads(declaration.object, DECLARE_PREFIX, null, null)[0];
      const namespaceQuad = store.getQuads(declaration.object, DECLARE_NAMESPACE, null, null)[0];
      const namespaceValid =
        namespaceQuad &&
        ((namespaceQuad.object.termType === 'Literal' && namespaceQuad.object.datatype?.value === ANY_URI) ||
          namespaceQuad.object.termType === 'NamedNode');
      if (!prefixQuad || prefixQuad.object.termType !== 'Literal' || !namespaceValid) {
        throw new TurtlePolicyError(
          `${context} sh:declare entries need a sh:prefix string and an xsd:anyURI sh:namespace.`,
        );
      }
    }
  }
}

export class TurtlePolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TurtlePolicyError';
  }
}

export type ParsedTurtlePolicy = {
  /** Number of shapes declaring `sh:targetClass`. */
  shape_count: number;
};

export function parseTurtlePolicyShapes(turtle: string): ParsedTurtlePolicy {
  let store: Store;
  try {
    store = new Store(new Parser({ format: 'text/turtle' }).parse(turtle));
  } catch (err) {
    throw new TurtlePolicyError(
      `Policy shapes Turtle failed to parse: ${err instanceof Error ? err.message : 'unknown error'}`,
    );
  }

  // SHACL-AF features that the engine would silently ignore: reject them
  // explicitly rather than letting a policy read as "conforms" unexecuted.
  for (const feature of UNEXECUTED_FEATURES) {
    if (store.getQuads(null, feature.predicate, null, null).length > 0) {
      throw new TurtlePolicyError(
        `Policy shapes must not use ${feature.label}: the registry's SHACL engine does not execute it and it would be silently ignored (a governance gate must never pass unexecuted).`,
      );
    }
  }

  // Property shapes are the objects of sh:property: their SPARQL semantics
  // in the registry's SPARQL-capable engine differ from the W3C prebinding
  // model, so sh:sparql is only supported on node shapes (constraints on
  // values are expressible with a traversal in the query).
  const propertyShapeSubjects = new Set(
    store.getQuads(null, PROPERTY, null, null).map((quad) => quad.object.value),
  );

  // Every sh:target must reference a SPARQL-based target (a node with
  // sh:select); other sh:target forms are silently inert in the engine.
  for (const quad of store.getQuads(null, TARGET, null, null)) {
    const selects = store.getQuads(quad.object, SELECT, null, null).filter((q) => q.object.termType === 'Literal');
    if (selects.length === 0) {
      throw new TurtlePolicyError(
        `Shape ${quad.subject.value} uses sh:target without a SPARQL-based target: sh:target must reference a node declaring sh:select (the registry does not support other sh:target forms).`,
      );
    }
    for (const selectQuad of selects) {
      assertSparqlSelectSafe(selectQuad.object.value, `Shape ${quad.subject.value} sh:target`);
    }
  }

  const shapeSubjects = new Set<string>();
  for (const quad of store.getQuads(null, TARGET_CLASS, null, null)) {
    shapeSubjects.add(quad.subject.value);
  }
  // SPARQL-based targets also count as shape targeting (validated above).
  for (const quad of store.getQuads(null, TARGET, null, null)) {
    shapeSubjects.add(quad.subject.value);
  }
  if (shapeSubjects.size === 0) {
    throw new TurtlePolicyError(
      'Policy shapes must declare at least one shape with sh:targetClass over a urn:sg:entity-type: IRI (or a SPARQL-based sh:target with sh:select).',
    );
  }

  for (const predicate of [TARGET_NODE, TARGET_OBJECTS_OF, TARGET_SUBJECTS_OF]) {
    const offending = store.getQuads(null, predicate, null, null);
    if (offending.length > 0) {
      throw new TurtlePolicyError(
        `Policy shapes must not use ${predicate.replace(SHACL_NS, 'sh:')}; target publications with sh:targetClass over urn:sg:entity-type: IRIs.`,
      );
    }
  }

  for (const quad of store.getQuads(null, SPARQL, null, null)) {
    if (propertyShapeSubjects.has(quad.subject.value)) {
      throw new TurtlePolicyError(
        'sh:sparql on property shapes is not supported: the registry\'s SPARQL engine evaluates property-shape constraints outside the W3C prebinding model. Put the constraint on the node shape and traverse with a property path (for example: $this <urn:sg:property:name> ?value).',
      );
    }
    validateSparqlBlock(store, quad.object, `Shape ${quad.subject.value} sh:sparql`);
  }

  for (const quad of store.getQuads(null, PATH, null, null)) {
    const target = quad.object;
    const valid =
      target.termType === 'NamedNode' &&
      (target.value.startsWith(SG_PROPERTY_PREFIX) || target.value.startsWith(SG_PREDICATE_PREFIX));
    if (!valid) {
      throw new TurtlePolicyError(
        `Policy shapes sh:path must be a simple IRI under ${SG_PROPERTY_PREFIX} or ${SG_PREDICATE_PREFIX} (got ${target.value}).`,
      );
    }
  }

  for (const quad of store.getQuads(null, PATTERN, null, null)) {
    if (quad.object.termType !== 'Literal') {
      throw new TurtlePolicyError('Policy shapes sh:pattern must be a string literal.');
    }
    try {
      RE2JS.compile(quad.object.value);
    } catch {
      throw new TurtlePolicyError(
        `Policy shapes sh:pattern is not a valid RE2 regular expression (backreferences and lookarounds are unsupported): ${quad.object.value}`,
      );
    }
    const paths = store.getQuads(quad.subject, PATH, null, null);
    if (paths.length !== 1) {
      throw new TurtlePolicyError(
        'Policy shapes with sh:pattern must declare exactly one simple sh:path on the same property shape.',
      );
    }
  }

  return { shape_count: shapeSubjects.size };
}
