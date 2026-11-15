import { describe, expect, it } from 'vitest';

// These tests pin the *frozen legacy reference engine* (ShapeDocument
// semantics, RE2 pattern safety, built-in graph shape). Production
// validation executes W3C SHACL — see shacl-publication-validation.test.ts
// for behavior and shacl-execution-parity.test.ts for the equivalence
// contract between the two.

import {
  BUILTIN_GRAPH_SHAPE_DOCUMENT,
  ShapeDocumentError,
  parseShapeDocument,
  validateShapes,
  type ShapeDocument,
  type ValidationDataGraph,
} from '../../../registry/application/services/shacl-like-validator.js';

function graph(overrides: Partial<ValidationDataGraph> = {}): ValidationDataGraph {
  return {
    focus_urn: 'urn:sg:skill-version:skill:demo@v1',
    entity_type: 'SKILL_VERSION',
    properties: {
      version: 1,
      artifact_sha256: 'abc123',
      source_path: 'skills/demo.md',
    },
    edges: [{ predicate: 'sg:implementedBy', to_urn: 'urn:sg:artifact:sha256:abc123', to_entity_type: 'ARTIFACT' }],
    ...overrides,
  };
}

function doc(shapes: ShapeDocument['shapes']): ShapeDocument {
  return { shapes };
}

describe('SHACL-like validator engine', () => {
  it('passes a conforming graph', () => {
    const document = doc([
      {
        id: 'shape/1',
        target: { entity_type: 'SKILL_VERSION' },
        properties: [{ path: 'artifact_sha256', minCount: 1 }],
      },
    ]);
    expect(validateShapes(graph(), document)).toEqual([]);
  });

  it('skips shapes targeting other entity types', () => {
    const document = doc([
      {
        id: 'shape/1',
        target: { entity_type: 'AGENT_VERSION' },
        properties: [{ path: 'nonexistent', minCount: 1 }],
      },
    ]);
    expect(validateShapes(graph(), document)).toEqual([]);
  });

  it('reports minCount and maxCount violations with SHACL result vocabulary', () => {
    const document = doc([
      {
        id: 'shape/counts',
        target: { entity_type: 'SKILL_VERSION' },
        properties: [
          { path: 'missing_prop', minCount: 1, message: 'prop required' },
          { path: 'multi', maxCount: 1 },
        ],
      },
    ]);
    const violations = validateShapes(
      graph({ properties: { multi: ['a', 'b'] } }),
      document,
    );
    expect(violations).toHaveLength(2);
    expect(violations[0]).toMatchObject({
      focusNode: 'urn:sg:skill-version:skill:demo@v1',
      resultPath: 'missing_prop',
      sourceConstraintComponent: 'MinCountConstraintComponent',
      sourceShape: 'shape/counts',
      message: 'prop required',
      severity: 'Violation',
    });
    expect(violations[1]).toMatchObject({
      resultPath: 'multi',
      sourceConstraintComponent: 'MaxCountConstraintComponent',
    });
  });

  it('enforces datatype constraints', () => {
    const document = doc([
      {
        id: 'shape/types',
        target: { entity_type: 'SKILL_VERSION' },
        properties: [
          { path: 'version', datatype: 'integer' },
          { path: 'artifact_sha256', datatype: 'integer' },
        ],
      },
    ]);
    const violations = validateShapes(graph(), document);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      resultPath: 'artifact_sha256',
      sourceConstraintComponent: 'DatatypeConstraintComponent',
    });
  });

  it('enforces in and pattern constraints', () => {
    const document = doc([
      {
        id: 'shape/values',
        target: { entity_type: 'SKILL_VERSION' },
        properties: [
          { path: 'lifecycle_status', in: ['draft', 'validated'] },
          { path: 'source_path', pattern: '^skills/' },
        ],
      },
    ]);
    const violations = validateShapes(
      graph({ properties: { lifecycle_status: 'revoked', source_path: 'other/x.md' } }),
      document,
    );
    expect(violations.map((v) => v.sourceConstraintComponent)).toEqual([
      'InConstraintComponent',
      'PatternConstraintComponent',
    ]);
  });

  it('enforces edge cardinality and target entity type', () => {
    const document = doc([
      {
        id: 'shape/edges',
        target: { entity_type: 'SKILL_VERSION' },
        edges: [
          { predicate: 'sg:implementedBy', minCount: 1, to_entity_type: 'ARTIFACT' },
          { predicate: 'sg:usesSkill', minCount: 1 },
        ],
      },
    ]);
    const missingEdge = validateShapes(graph({ edges: [] }), document);
    expect(missingEdge.map((v) => v.resultPath)).toEqual(['sg:implementedBy', 'sg:usesSkill']);

    const wrongTarget = validateShapes(
      graph({ edges: [{ predicate: 'sg:implementedBy', to_urn: 'urn:x', to_entity_type: 'SKILL' }] }),
      document,
    );
    expect(wrongTarget).toHaveLength(2);
    expect(wrongTarget[0]).toMatchObject({ sourceConstraintComponent: 'ClassConstraintComponent' });
  });

  it('keeps Warning severity as evidence rather than failure', () => {
    const document = doc([
      {
        id: 'shape/warn',
        target: { entity_type: 'SKILL_VERSION' },
        properties: [{ path: 'description', minCount: 1, severity: 'Warning', message: 'description recommended' }],
      },
    ]);
    const violations = validateShapes(graph(), document);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.severity).toBe('Warning');
  });

  it('validates the built-in graph-shape document against drafts', () => {
    expect(validateShapes(graph(), BUILTIN_GRAPH_SHAPE_DOCUMENT)).toEqual([]);

    const noSourcePath = validateShapes(
      graph({ properties: { version: 1, artifact_sha256: 'abc' } }),
      BUILTIN_GRAPH_SHAPE_DOCUMENT,
    );
    expect(noSourcePath.map((v) => v.message)).toEqual(['missing_source_path_evidence']);

    const noArtifact = validateShapes(
      graph({ properties: { version: 1, source_path: 'x.md' }, edges: [] }),
      BUILTIN_GRAPH_SHAPE_DOCUMENT,
    );
    expect(noArtifact.map((v) => v.message)).toEqual(['missing_artifact_evidence', 'missing_implementation_edge']);
  });
});

describe('shape document parsing', () => {
  it('parses a valid document', () => {
    const parsed = parseShapeDocument({
      shapes: [
        {
          id: 'shape/1',
          target: { entity_type: 'SKILL_VERSION' },
          properties: [{ path: 'version', minCount: 1, datatype: 'integer' }],
          edges: [{ predicate: 'sg:implementedBy', minCount: 1 }],
        },
      ],
    });
    expect(parsed.shapes).toHaveLength(1);
    expect(parsed.shapes[0]?.properties?.[0]).toMatchObject({ path: 'version', minCount: 1 });
  });

  it('rejects malformed documents', () => {
    expect(() => parseShapeDocument(null)).toThrow(ShapeDocumentError);
    expect(() => parseShapeDocument({})).toThrow(ShapeDocumentError);
    expect(() => parseShapeDocument({ shapes: [] })).toThrow(ShapeDocumentError);
    expect(() => parseShapeDocument({ shapes: [{ target: { entity_type: 'X' } }] })).toThrow(ShapeDocumentError);
    expect(() => parseShapeDocument({ shapes: [{ id: 's', target: {} }] })).toThrow(ShapeDocumentError);
    expect(() =>
      parseShapeDocument({ shapes: [{ id: 's', target: { entity_type: 'X' }, properties: [{ minCount: 1 }] }] }),
    ).toThrow(ShapeDocumentError);
    expect(() =>
      parseShapeDocument({
        shapes: [{ id: 's', target: { entity_type: 'X' }, properties: [{ path: 'p', minCount: -1 }] }],
      }),
    ).toThrow(ShapeDocumentError);
    expect(() =>
      parseShapeDocument({
        shapes: [{ id: 's', target: { entity_type: 'X' }, properties: [{ path: 'p', datatype: 'date' }] }],
      }),
    ).toThrow(ShapeDocumentError);
    expect(() =>
      parseShapeDocument({
        shapes: [{ id: 's', target: { entity_type: 'X' }, properties: [{ path: 'p', pattern: '(' }] }],
      }),
    ).toThrow(ShapeDocumentError);
  });

  it('executes catastrophic-backtracking patterns in linear time (ReDoS-safe via RE2)', () => {
    // (a+)+$ would hang a backtracking engine against a long non-matching
    // input; RE2 executes it in linear time and simply reports no match.
    const document = doc([
      {
        id: 'shape/redos',
        target: { entity_type: 'SKILL_VERSION' },
        properties: [{ path: 'source_path', pattern: '(a+)+$' }],
      },
    ]);
    const adversarial = `${'a'.repeat(50_000)}b`;
    const start = Date.now();
    const violations = validateShapes(graph({ properties: { source_path: adversarial } }), document);
    expect(Date.now() - start).toBeLessThan(5_000);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ sourceConstraintComponent: 'PatternConstraintComponent' });
  });

  it('rejects Perl-only pattern syntax unsupported by RE2 at registration', () => {
    // Lookarounds and backreferences are rejected; RE2-supported features
    // such as named capture groups remain available.
    for (const pattern of ['a(?=b)', 'a(?!b)', '(a)\\1']) {
      expect(() =>
        parseShapeDocument({
          shapes: [{ id: 's', target: { entity_type: 'X' }, properties: [{ path: 'p', pattern }] }],
        }),
      ).toThrow(/not a valid RE2 regular expression/);
    }
  });

  it('accepts safe patterns', () => {
    for (const pattern of ['^skills/', '^[a-z0-9-]+$', '^urn:sg:[a-z-]+:[a-z0-9.-]+$', '(a+)+$']) {
      const parsed = parseShapeDocument({
        shapes: [{ id: 's', target: { entity_type: 'X' }, properties: [{ path: 'p', pattern }] }],
      });
      expect(parsed.shapes[0]?.properties?.[0]?.pattern).toBe(pattern);
    }
  });
});
