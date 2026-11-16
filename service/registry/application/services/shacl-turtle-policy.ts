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

import { Parser, Store } from 'n3';
import { RE2JS } from 're2js';

import { SG_PREDICATE_PREFIX, SG_PROPERTY_PREFIX } from './sg-vocabulary.js';

const SHACL_NS = 'http://www.w3.org/ns/shacl#';

const TARGET_CLASS = `${SHACL_NS}targetClass`;
const TARGET_NODE = `${SHACL_NS}targetNode`;
const TARGET_OBJECTS_OF = `${SHACL_NS}targetObjectsOf`;
const TARGET_SUBJECTS_OF = `${SHACL_NS}targetSubjectsOf`;
const PATH = `${SHACL_NS}path`;
const PATTERN = `${SHACL_NS}pattern`;

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

  const shapeSubjects = new Set<string>();
  for (const quad of store.getQuads(null, TARGET_CLASS, null, null)) {
    shapeSubjects.add(quad.subject.value);
  }
  if (shapeSubjects.size === 0) {
    throw new TurtlePolicyError(
      'Policy shapes must declare at least one shape with sh:targetClass over a urn:sg:entity-type: IRI.',
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
