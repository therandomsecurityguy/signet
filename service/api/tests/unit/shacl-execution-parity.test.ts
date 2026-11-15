import { describe, expect, it } from 'vitest';

import {
  BUILTIN_GRAPH_SHAPE_DOCUMENT,
  validateShapes,
  type ShapeDocument,
  type ValidationDataGraph,
  type ValidationViolation,
} from '../../../registry/application/services/shacl-like-validator.js';
import { validatePublicationGraphWithShacl } from '../../../registry/application/services/shacl-publication-validation.js';

/**
 * Parity suite: the frozen legacy reference engine and the W3C SHACL
 * execution path must produce identical violation tuples (focusNode,
 * resultPath, component, sourceShape, message, severity) over a matrix of
 * shape documents and graphs. This is the migration's correctness contract
 * — legacy JSON policy packages keep their exact gating behavior.
 */

function doc(shapes: ShapeDocument['shapes']): ShapeDocument {
  return { shapes };
}

function base(overrides: Partial<ValidationDataGraph> = {}): ValidationDataGraph {
  return {
    focus_urn: 'urn:sg:skill-version:skill:demo@v1',
    entity_type: 'SKILL_VERSION',
    properties: {
      version: 1,
      artifact_sha256: 'abc123',
      source_path: 'skills/demo.md',
      lifecycle_status: 'draft',
      enabled: true,
      score: 4.5,
      description: 'demo skill',
    },
    edges: [
      { predicate: 'sg:implementedBy', to_urn: 'urn:sg:artifact:sha256:abc123', to_entity_type: 'ARTIFACT' },
      { predicate: 'sg:usesSkill', to_urn: 'urn:sg:skill:helper', to_entity_type: 'SKILL' },
    ],
    ...overrides,
  };
}

const documents: Array<{ name: string; document: ShapeDocument }> = [
  {
    name: 'counts with custom and fallback messages',
    document: doc([
      {
        id: 'shape/counts',
        target: { entity_type: 'SKILL_VERSION' },
        properties: [
          { path: 'missing_prop', minCount: 2, message: 'prop required twice' },
          { path: 'lifecycle_status', maxCount: 1 },
        ],
        edges: [{ predicate: 'sg:dependsOn', minCount: 1, maxCount: 2 }],
      },
    ]),
  },
  {
    name: 'all datatypes',
    document: doc([
      {
        id: 'shape/types',
        target: { entity_type: 'SKILL_VERSION' },
        properties: [
          { path: 'version', datatype: 'integer' },
          { path: 'score', datatype: 'number' },
          { path: 'enabled', datatype: 'boolean' },
          { path: 'source_path', datatype: 'string' },
        ],
      },
    ]),
  },
  {
    name: 'in lists (primitive and non-primitive entries)',
    document: doc([
      {
        id: 'shape/in',
        target: { entity_type: 'SKILL_VERSION' },
        properties: [
          { path: 'lifecycle_status', in: ['draft', 'validated'] },
          { path: 'version', in: [1, 2, { nested: true }] },
        ],
      },
    ]),
  },
  {
    name: 'patterns with severities',
    document: doc([
      {
        id: 'shape/patterns',
        target: { entity_type: 'SKILL_VERSION' },
        properties: [
          { path: 'source_path', pattern: '^skills/' },
          { path: 'description', pattern: 'demo', severity: 'Warning', message: 'mention demo' },
        ],
      },
    ]),
  },
  {
    name: 'edges with class and cardinality',
    document: doc([
      {
        id: 'shape/edges',
        target: { entity_type: 'SKILL_VERSION' },
        edges: [
          { predicate: 'sg:implementedBy', minCount: 1, to_entity_type: 'ARTIFACT', message: 'needs artifact' },
          { predicate: 'sg:usesSkill', maxCount: 1, to_entity_type: 'SKILL' },
        ],
      },
    ]),
  },
  {
    name: 'multiple shapes including a non-matching target',
    document: doc([
      {
        id: 'shape/skill',
        target: { entity_type: 'SKILL_VERSION' },
        properties: [{ path: 'description', minCount: 1, severity: 'Info' }],
      },
      {
        id: 'shape/agent-only',
        target: { entity_type: 'AGENT_VERSION' },
        properties: [{ path: 'whatever', minCount: 5 }],
      },
    ]),
  },
  {
    name: 'nested structures against string datatype',
    document: doc([
      {
        id: 'shape/nested',
        target: { entity_type: 'SKILL_VERSION' },
        properties: [{ path: 'lineage', datatype: 'string' }],
      },
    ]),
  },
  {
    name: 'builtin graph shape',
    document: BUILTIN_GRAPH_SHAPE_DOCUMENT,
  },
];

const graphs: Array<{ name: string; graph: ValidationDataGraph }> = [
  { name: 'conforming', graph: base() },
  { name: 'empty properties and edges', graph: base({ properties: {}, edges: [] }) },
  {
    name: 'wrong datatypes',
    graph: base({ properties: { version: 'one', score: 'high', enabled: 'yes', source_path: 'other/x.md' } }),
  },
  {
    name: 'multi-values with filtered nulls',
    graph: base({ properties: { lifecycle_status: ['draft', 'validated', null, undefined], version: [1, 'one'] } }),
  },
  {
    name: 'wrong edge target types',
    graph: base({
      edges: [
        { predicate: 'sg:implementedBy', to_urn: 'urn:sg:skill:wrong', to_entity_type: 'SKILL' },
        { predicate: 'sg:usesSkill', to_urn: 'urn:sg:artifact:wrong', to_entity_type: 'ARTIFACT' },
      ],
    }),
  },
  {
    name: 'untyped edge targets',
    graph: base({
      edges: [
        { predicate: 'sg:implementedBy', to_urn: 'urn:sg:artifact:sha256:abc123', to_entity_type: 'ARTIFACT' },
        { predicate: 'sg:usesSkill', to_urn: 'urn:sg:unresolved:x' },
      ],
    }),
  },
  {
    name: 'type-mismatched in values',
    graph: base({ properties: { lifecycle_status: 'archived', version: 3 } }),
  },
  {
    name: 'nested structures',
    graph: base({ properties: { lineage: { up: ['a'] }, description: 'no marker' } }),
  },
  {
    name: 'falsy values',
    graph: base({ properties: { enabled: false, version: 0, description: '' } }),
  },
  {
    name: 'long adversarial pattern input',
    graph: base({ properties: { source_path: `${'a'.repeat(5_000)}b` } }),
  },
];

function normalize(violations: ValidationViolation[]): string[] {
  return violations
    .map((violation) =>
      JSON.stringify([
        violation.focusNode,
        violation.resultPath ?? '',
        violation.sourceConstraintComponent,
        violation.sourceShape,
        violation.message,
        violation.severity,
      ]),
    )
    .sort();
}

describe('W3C SHACL execution parity with the legacy engine', () => {
  for (const { name, document } of documents) {
    for (const { name: graphName, graph } of graphs) {
      it(`${name} x ${graphName}`, async () => {
        const legacy = normalize(validateShapes(graph, document));
        const shacl = normalize(await validatePublicationGraphWithShacl({ graph, document }));
        expect(shacl).toEqual(legacy);
      });
    }
  }
});
