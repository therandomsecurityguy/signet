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
const CONSTRUCT = `${SHACL_NS}construct`;
const ASK = `${SHACL_NS}ask`;
const RULE = `${SHACL_NS}rule`;
const FUNCTION = `${SHACL_NS}function`;
const PARAMETER = `${SHACL_NS}parameter`;
const CONSTRAINT_COMPONENT = `${SHACL_NS}ConstraintComponent`;
const NODE_VALIDATOR = `${SHACL_NS}nodeValidator`;
const PROPERTY_VALIDATOR = `${SHACL_NS}propertyValidator`;
const VALIDATOR = `${SHACL_NS}validator`;
const TRIPLE_RULE = `${SHACL_NS}TripleRule`;
const SPARQL_RULE = `${SHACL_NS}SPARQLRule`;
const SPARQL_FUNCTION = `${SHACL_NS}SPARQLFunction`;
const SPARQL_SELECT_VALIDATOR = `${SHACL_NS}SPARQLSelectValidator`;
const SPARQL_ASK_VALIDATOR = `${SHACL_NS}SPARQLAskValidator`;
const RDF_TYPE_PREDICATE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const ANY_URI = 'http://www.w3.org/2001/XMLSchema#anyURI';

/**
 * Features that nothing executes. `sh:rule`, `sh:function`, and custom
 * constraint components are executed by the SHACL-AF runtime sidecar
 * (registration accepts them; validation fails closed when no runtime is
 * configured) — but JS-based features and node expressions stay refused:
 * silent non-execution would read as "conforms", never acceptable for a
 * governance gate.
 */
const UNEXECUTED_FEATURES: Array<{ predicate: string; label: string }> = [
  { predicate: `${SHACL_NS}js`, label: 'sh:js (JavaScript-based constraints)' },
  { predicate: `${SHACL_NS}expression`, label: 'sh:expression (SHACL-AF node expressions)' },
];

function assertSparqlTextSafe(selectText: string, context: string): void {
  if (selectText.trim().length === 0) {
    throw new TurtlePolicyError(`${context} SPARQL must be a non-empty string.`);
  }
  // The SPARQL engines (in-process and the pyshacl runtime) execute REGEX()
  // with a backtracking regex — the same ReDoS class deliberately banned
  // from sh:pattern (which stays RE2-owned). Regex work belongs in
  // sh:pattern.
  if (/REGEX\s*\(/i.test(selectText)) {
    throw new TurtlePolicyError(
      `${context} uses REGEX() in SPARQL: the engines execute it with a backtracking regex (ReDoS-unsafe). Use the RE2-backed sh:pattern constraint for regex checks.`,
    );
  }
  // pyshacl refuses SERVICE in sh:sparql constraints but EXECUTES it from
  // sh:SPARQLRule constructs (probe-proven outbound request = SSRF); the
  // runtime rejects it before execution, and registration refuses it so a
  // registered policy can never rely on federation.
  const withoutComments = selectText.replace(/#[^\n]*/g, '');
  if (/\bservice\b/i.test(selectText) || /\bservice\b/i.test(withoutComments)) {
    throw new TurtlePolicyError(
      `${context} uses SPARQL SERVICE (federated queries): not supported — validation must never perform outbound requests.`,
    );
  }
}

function validateSparqlBlock(store: Store, block: Term, context: string): void {
  const queryPredicates = [SELECT, CONSTRUCT, ASK];
  const queryQuads = queryPredicates.flatMap((predicate) =>
    store.getQuads(block, predicate, null, null).filter((quad) => quad.object.termType === 'Literal'),
  );
  if (queryQuads.length === 0) {
    throw new TurtlePolicyError(`${context} requires a sh:select, sh:construct, or sh:ask string.`);
  }
  for (const queryQuad of queryQuads) {
    assertSparqlTextSafe(queryQuad.object.value, context);
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

function typeOf(store: Store, node: Term): string[] {
  return store.getQuads(node, RDF_TYPE_PREDICATE, null, null).map((quad) => quad.object.value);
}

/** pyshacl derives parameter/function variable names from the sh:path local
 * name; fragment- or path-derived IRIs are required. */
function validateParameterPaths(store: Store): void {
  for (const parameterQuad of store.getQuads(null, PARAMETER, null, null)) {
    const paths = store.getQuads(parameterQuad.object, PATH, null, null);
    if (paths.length !== 1 || paths[0]?.object.termType !== 'NamedNode') {
      throw new TurtlePolicyError(
        'SHACL-AF sh:parameter nodes must declare exactly one IRI sh:path.',
      );
    }
    const pathIri = paths[0].object.value;
    if (!pathIri.includes('#') && !pathIri.includes('/')) {
      throw new TurtlePolicyError(
        `SHACL-AF sh:parameter path ${pathIri} must be localname-derivable (contain a '#' fragment or a '/' segment); the runtime derives variable names from it.`,
      );
    }
  }
}

function validateRules(store: Store): void {
  for (const ruleQuad of store.getQuads(null, RULE, null, null)) {
    const ruleTypes = typeOf(store, ruleQuad.object);
    const isTripleRule = ruleTypes.includes(TRIPLE_RULE);
    const isSparqlRule = ruleTypes.includes(SPARQL_RULE);
    if (!isTripleRule && !isSparqlRule) {
      throw new TurtlePolicyError(
        `Rule on shape ${ruleQuad.subject.value} must be a sh:TripleRule or sh:SPARQLRule (JS rules are not executed).`,
      );
    }
    if (isSparqlRule) {
      validateSparqlBlock(store, ruleQuad.object, `Rule on shape ${ruleQuad.subject.value}`);
    }
  }
}

function validateFunctions(store: Store): void {
  for (const functionQuad of store.getQuads(null, FUNCTION, null, null)) {
    if (!typeOf(store, functionQuad.object).includes(SPARQL_FUNCTION)) {
      throw new TurtlePolicyError(
        `Function ${functionQuad.object.value} must be typed sh:SPARQLFunction.`,
      );
    }
    validateSparqlBlock(store, functionQuad.object, `Function ${functionQuad.object.value}`);
  }
}

function validateConstraintComponents(store: Store): void {
  for (const componentQuad of store.getQuads(null, RDF_TYPE_PREDICATE, CONSTRAINT_COMPONENT, null)) {
    const component = componentQuad.subject;
    if (store.getQuads(component, PARAMETER, null, null).length === 0) {
      throw new TurtlePolicyError(
        `Constraint component ${component.value} must declare at least one sh:parameter.`,
      );
    }
    for (const validatorPredicate of [NODE_VALIDATOR, PROPERTY_VALIDATOR]) {
      for (const validatorQuad of store.getQuads(component, validatorPredicate, null, null)) {
        const validatorTypes = typeOf(store, validatorQuad.object);
        if (!validatorTypes.includes(SPARQL_SELECT_VALIDATOR) && !validatorTypes.includes(SPARQL_ASK_VALIDATOR)) {
          throw new TurtlePolicyError(
            `Validator on component ${component.value} must be a sh:SPARQLSelectValidator or sh:SPARQLAskValidator.`,
          );
        }
        validateSparqlBlock(
          store,
          validatorQuad.object,
          `Validator on component ${component.value}`,
        );
      }
    }
    for (const validatorQuad of store.getQuads(component, VALIDATOR, null, null)) {
      const validatorTypes = typeOf(store, validatorQuad.object);
      const hasAsk = store.getQuads(validatorQuad.object, ASK, null, null).length > 0;
      if (!validatorTypes.includes(SPARQL_ASK_VALIDATOR) || !hasAsk) {
        throw new TurtlePolicyError(
          `Generic sh:validator on component ${component.value} must be a sh:SPARQLAskValidator with sh:ask (the runtime refuses generic SELECT validators).`,
        );
      }
      validateSparqlBlock(store, validatorQuad.object, `Validator on component ${component.value}`);
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

  // Features that nothing executes: rejected explicitly rather than letting
  // a policy read as "conforms" unexecuted.
  for (const feature of UNEXECUTED_FEATURES) {
    if (store.getQuads(null, feature.predicate, null, null).length > 0) {
      throw new TurtlePolicyError(
        `Policy shapes must not use ${feature.label}: no configured engine executes it and it would be silently ignored (a governance gate must never pass unexecuted).`,
      );
    }
  }

  // SHACL-AF constructs (rules, SPARQL functions, custom constraint
  // components) are executed by the SHACL-AF runtime sidecar; registration
  // validates their structure and SPARQL safety so a registered policy can
  // never rely on silently-ignored semantics.
  validateParameterPaths(store);
  validateRules(store);
  validateFunctions(store);
  validateConstraintComponents(store);

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
      assertSparqlTextSafe(selectQuad.object.value, `Shape ${quad.subject.value} sh:target`);
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

  // Simple sg-vocabulary paths for shape constraints; SHACL-AF parameter
  // nodes carry their own predicate IRIs and are validated separately
  // (localname-derivable rule), so they are exempt here.
  const parameterNodes = new Set(
    store.getQuads(null, PARAMETER, null, null).map((quad) => quad.object.value),
  );
  for (const quad of store.getQuads(null, PATH, null, null)) {
    if (parameterNodes.has(quad.subject.value)) continue;
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
