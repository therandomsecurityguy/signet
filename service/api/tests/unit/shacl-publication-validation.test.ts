import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  BUILTIN_GRAPH_SHAPE_DOCUMENT,
  type ShapeDocument,
  type ValidationDataGraph,
} from '../../../registry/application/services/shacl-like-validator.js';
import {
  buildValidationDatasetNQuads,
  validatePublicationGraphWithShacl,
} from '../../../registry/application/services/shacl-publication-validation.js';
import type { ShaclExecutionPort } from '../../../registry/application/services/shacl-execution-port.js';
import { RDF_VALIDATE_SHACL_ENGINE_ID } from '../../../registry/application/services/rdf-validate-shacl-engine.js';

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

describe('W3C SHACL publication validation', () => {
  it('passes a conforming graph', async () => {
    const document = doc([
      {
        id: 'shape/1',
        target: { entity_type: 'SKILL_VERSION' },
        properties: [{ path: 'artifact_sha256', minCount: 1 }],
      },
    ]);
    expect(await validatePublicationGraphWithShacl({ graph: graph(), document })).toEqual([]);
  });

  it('skips shapes targeting other entity types', async () => {
    const document = doc([
      {
        id: 'shape/1',
        target: { entity_type: 'AGENT_VERSION' },
        properties: [{ path: 'nonexistent', minCount: 1 }],
      },
    ]);
    expect(await validatePublicationGraphWithShacl({ graph: graph(), document })).toEqual([]);
  });

  it('reports minCount and maxCount violations with SHACL result vocabulary', async () => {
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
    const violations = await validatePublicationGraphWithShacl({
      graph: graph({ properties: { multi: ['a', 'b'] } }),
      document,
    });
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
      message: 'requires at most 1 value(s) for multi',
    });
  });

  it('enforces all four datatypes, including number via sh:or', async () => {
    const document = doc([
      {
        id: 'shape/types',
        target: { entity_type: 'SKILL_VERSION' },
        properties: [
          { path: 'version', datatype: 'integer' },
          { path: 'artifact_sha256', datatype: 'integer' },
          { path: 'score', datatype: 'number' },
          { path: 'enabled', datatype: 'boolean' },
          { path: 'source_path', datatype: 'string' },
        ],
      },
    ]);

    const violations = await validatePublicationGraphWithShacl({
      graph: graph({
        properties: {
          version: 1,
          artifact_sha256: 'abc',
          score: 4.5,
          enabled: 'yes',
          source_path: 'skills/x.md',
        },
      }),
      document,
    });
    expect(violations.map((v) => [v.resultPath, v.sourceConstraintComponent])).toEqual([
      ['artifact_sha256', 'DatatypeConstraintComponent'],
      ['enabled', 'DatatypeConstraintComponent'],
    ]);
  });

  it('reports number-datatype failures under DatatypeConstraintComponent', async () => {
    const document = doc([
      {
        id: 'shape/number',
        target: { entity_type: 'SKILL_VERSION' },
        properties: [{ path: 'score', datatype: 'number' }],
      },
    ]);
    const violations = await validatePublicationGraphWithShacl({
      graph: graph({ properties: { score: 'high' } }),
      document,
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      sourceConstraintComponent: 'DatatypeConstraintComponent',
      message: 'value for score must be of datatype number',
    });
  });

  it('does not let nested structures satisfy string datatypes', async () => {
    const document = doc([
      {
        id: 'shape/nested',
        target: { entity_type: 'SKILL_VERSION' },
        properties: [
          { path: 'lineage', datatype: 'string' },
          { path: 'openlineage', minCount: 1 },
        ],
      },
    ]);
    const violations = await validatePublicationGraphWithShacl({
      graph: graph({ properties: { lineage: { upstream: ['a'] }, openlineage: { run: 'x' } } }),
      document,
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      resultPath: 'lineage',
      sourceConstraintComponent: 'DatatypeConstraintComponent',
    });
  });

  it('enforces in and pattern constraints', async () => {
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
    const violations = await validatePublicationGraphWithShacl({
      graph: graph({ properties: { lifecycle_status: 'revoked', source_path: 'other/x.md' } }),
      document,
    });
    expect(violations.map((v) => v.sourceConstraintComponent)).toEqual([
      'InConstraintComponent',
      'PatternConstraintComponent',
    ]);
  });

  it('compares in-lists with RDF literal semantics (numbers stay numbers)', async () => {
    const document = doc([
      {
        id: 'shape/in-typed',
        target: { entity_type: 'SKILL_VERSION' },
        properties: [{ path: 'version', in: [1, 2] }],
      },
    ]);
    expect(
      await validatePublicationGraphWithShacl({ graph: graph({ properties: { version: 2 } }), document }),
    ).toEqual([]);
    const violations = await validatePublicationGraphWithShacl({
      graph: graph({ properties: { version: '2' } }),
      document,
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.sourceConstraintComponent).toBe('InConstraintComponent');
  });

  it('enforces edge cardinality and target entity type', async () => {
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
    const missingEdge = await validatePublicationGraphWithShacl({
      graph: graph({ edges: [] }),
      document,
    });
    expect(missingEdge.map((v) => v.resultPath)).toEqual(['sg:implementedBy', 'sg:usesSkill']);

    const wrongTarget = await validatePublicationGraphWithShacl({
      graph: graph({ edges: [{ predicate: 'sg:implementedBy', to_urn: 'urn:x', to_entity_type: 'SKILL' }] }),
      document,
    });
    expect(wrongTarget).toHaveLength(2);
    expect(wrongTarget[0]).toMatchObject({
      sourceConstraintComponent: 'ClassConstraintComponent',
      message: 'edge sg:implementedBy must target entity type ARTIFACT',
    });
  });

  it('exposes fallback messages matching the legacy wording', async () => {
    const document = doc([
      {
        id: 'shape/fallbacks',
        target: { entity_type: 'SKILL_VERSION' },
        properties: [{ path: 'license', minCount: 1 }],
        edges: [{ predicate: 'sg:usesSkill', minCount: 2 }],
      },
    ]);
    const violations = await validatePublicationGraphWithShacl({
      graph: graph({ edges: [] }),
      document,
    });
    expect(violations.map((v) => v.message)).toEqual([
      'requires at least 1 value(s) for license',
      'requires at least 2 edge(s) with predicate sg:usesSkill',
    ]);
  });

  it('keeps Warning severity as evidence rather than failure', async () => {
    const document = doc([
      {
        id: 'shape/warn',
        target: { entity_type: 'SKILL_VERSION' },
        properties: [{ path: 'description', minCount: 1, severity: 'Warning', message: 'description recommended' }],
      },
    ]);
    const violations = await validatePublicationGraphWithShacl({ graph: graph(), document });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.severity).toBe('Warning');
  });

  it('validates the built-in graph-shape document against drafts', async () => {
    expect(await validatePublicationGraphWithShacl({ graph: graph(), document: BUILTIN_GRAPH_SHAPE_DOCUMENT })).toEqual([]);

    const noSourcePath = await validatePublicationGraphWithShacl({
      graph: graph({ properties: { version: 1, artifact_sha256: 'abc' } }),
      document: BUILTIN_GRAPH_SHAPE_DOCUMENT,
    });
    expect(noSourcePath.map((v) => v.message)).toEqual(['missing_source_path_evidence']);

    const noArtifact = await validatePublicationGraphWithShacl({
      graph: graph({ properties: { version: 1, source_path: 'x.md' }, edges: [] }),
      document: BUILTIN_GRAPH_SHAPE_DOCUMENT,
    });
    expect(noArtifact.map((v) => v.message)).toEqual(['missing_artifact_evidence', 'missing_implementation_edge']);
  });

  it('orders multi-value violations deterministically', async () => {
    const document = doc([
      {
        id: 'shape/multi',
        target: { entity_type: 'SKILL_VERSION' },
        properties: [{ path: 'lifecycle_status', in: ['draft'] }],
      },
    ]);
    const first = await validatePublicationGraphWithShacl({
      graph: graph({ properties: { lifecycle_status: ['zeta', 'alpha'] } }),
      document,
    });
    const second = await validatePublicationGraphWithShacl({
      graph: graph({ properties: { lifecycle_status: ['alpha', 'zeta'] } }),
      document,
    });
    expect(first.map((v) => v.message)).toEqual(['value for lifecycle_status must be one of the allowed values', 'value for lifecycle_status must be one of the allowed values']);
    expect(second).toEqual(first);
  });
});

describe('validation dataset encoding', () => {
  it('emits typed literals and entity-type triples for the focus and edge targets', () => {
    const lines = buildValidationDatasetNQuads(graph());
    expect(lines).toContain(
      '<urn:sg:skill-version:skill:demo@v1> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <urn:sg:entity-type:SKILL_VERSION> .',
    );
    expect(lines).toContain(
      '<urn:sg:artifact:sha256:abc123> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <urn:sg:entity-type:ARTIFACT> .',
    );
    expect(lines).toContain(
      '<urn:sg:skill-version:skill:demo@v1> <urn:sg:property:version> "1"^^<http://www.w3.org/2001/XMLSchema#integer> .',
    );
    expect(lines).toContain(
      '<urn:sg:skill-version:skill:demo@v1> <urn:sg:predicate:sg-implementedBy> <urn:sg:artifact:sha256:abc123> .',
    );
  });

  it('encodes nested structures with the json datatype (not xsd:string)', () => {
    const lines = buildValidationDatasetNQuads(graph({ properties: { nested: { a: 1 } } }));
    expect(lines.some((line) => line.includes('urn:sg:datatype:json'))).toBe(true);
  });
});

describe('engine boundary guarantees', () => {
  it('pins the recorded engine id to the package.json dependency', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../../../registry/package.json', import.meta.url), 'utf8'),
    ) as { dependencies: Record<string, string> };
    const version = RDF_VALIDATE_SHACL_ENGINE_ID.split('@')[1];
    expect(pkg.dependencies['rdf-validate-shacl']).toBe(`^${version}`);
  });

  it('never sends sh:pattern to the engine (RE2 owns patterns)', async () => {
    let capturedShapes = '';
    const fake: ShaclExecutionPort = {
      engine: 'capturing-fake@0',
      validate: async (input) => {
        capturedShapes = input.shapes_turtle;
        return { conforms: true, results: [] };
      },
    };
    const document = doc([
      {
        id: 'shape/redos',
        target: { entity_type: 'SKILL_VERSION' },
        properties: [{ path: 'source_path', pattern: '^(a+)+$' }],
      },
    ]);
    const violations = await validatePublicationGraphWithShacl(
      { graph: graph({ properties: { source_path: `${'a'.repeat(50_000)}b` } }), document },
      fake,
    );
    expect(capturedShapes).not.toContain('sh:pattern');
    expect(capturedShapes).not.toContain('(a+)+$');
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ sourceConstraintComponent: 'PatternConstraintComponent' });
  });

  it('executes catastrophic-backtracking patterns in linear time through the full stack', async () => {
    const document = doc([
      {
        id: 'shape/redos',
        target: { entity_type: 'SKILL_VERSION' },
        properties: [{ path: 'source_path', pattern: '(a+)+$' }],
      },
    ]);
    const adversarial = `${'a'.repeat(50_000)}b`;
    const start = Date.now();
    const violations = await validatePublicationGraphWithShacl({
      graph: graph({ properties: { source_path: adversarial } }),
      document,
    });
    expect(Date.now() - start).toBeLessThan(5_000);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ sourceConstraintComponent: 'PatternConstraintComponent' });
  });

  it('validates a 2000-node graph well inside a generous bound', async () => {
    const shapes = doc([
      {
        id: 'shape/perf',
        target: { entity_type: 'SKILL_VERSION' },
        properties: [{ path: 'bulk_0000', minCount: 1 }],
        edges: [{ predicate: 'sg:implementedBy', minCount: 1, to_entity_type: 'ARTIFACT' }],
      },
    ]);
    const properties: Record<string, unknown> = {};
    const edges: ValidationDataGraph['edges'] = [];
    for (let i = 0; i < 2000; i += 1) {
      properties[`bulk_${i.toString().padStart(4, '0')}`] = `${'x'.repeat(64)}`;
      edges.push({ predicate: 'sg:implementedBy', to_urn: `urn:sg:artifact:sha256:${i.toString(16).padStart(64, '0')}`, to_entity_type: 'ARTIFACT' });
    }
    // 2000 edges is far beyond real publication graphs; the bound is a
    // smoke check that execution stays in-process and bounded.
    const start = Date.now();
    const violations = await validatePublicationGraphWithShacl({
      graph: graph({ properties, edges }),
      document: shapes,
    });
    expect(Date.now() - start).toBeLessThan(5_000);
    expect(violations).toEqual([]);
  });
});
