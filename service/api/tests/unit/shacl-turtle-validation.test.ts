import { describe, expect, it } from 'vitest';

import { BUILTIN_GRAPH_SHAPE_SHA256, BUILTIN_GRAPH_SHAPE_TURTLE } from '../../../registry/application/services/builtin-graph-shape.js';
import { BUILTIN_GRAPH_SHAPE_DOCUMENT, type ValidationDataGraph } from '../../../registry/application/services/shacl-like-validator.js';
import {
  validatePublicationGraphWithShacl,
  validatePublicationGraphWithTurtleShapes,
} from '../../../registry/application/services/shacl-publication-validation.js';
import { predicateIri, SG_PREDICATE_PREFIX, SG_PROPERTY_PREFIX } from '../../../registry/application/services/sg-vocabulary.js';
import { parseTurtlePolicyShapes, TurtlePolicyError } from '../../../registry/application/services/shacl-turtle-policy.js';

function graph(overrides: Partial<ValidationDataGraph> = {}): ValidationDataGraph {
  return {
    focus_urn: 'urn:sg:skill-version:skill:demo@v1',
    entity_type: 'SKILL_VERSION',
    properties: {
      version: 1,
      artifact_sha256: 'abc123',
      source_path: 'skills/demo.md',
      description: 'demo',
    },
    edges: [{ predicate: 'sg:implementedBy', to_urn: 'urn:sg:artifact:sha256:abc123', to_entity_type: 'ARTIFACT' }],
    ...overrides,
  };
}

const DESCRIPTION_TURTLE = `@prefix sh: <http://www.w3.org/ns/shacl#> .

<urn:policy:description> a sh:NodeShape ;
    sh:targetClass <urn:sg:entity-type:SKILL_VERSION> ;
    sh:property [
        sh:path <urn:sg:property:description> ;
        sh:minCount 1 ;
        sh:message "description_required_by_shacl_policy" ;
    ] .
`;

describe('authored Turtle policy registration', () => {
  it('accepts the supported authoring conventions', () => {
    expect(parseTurtlePolicyShapes(DESCRIPTION_TURTLE)).toEqual({ shape_count: 1 });
  });

  it('rejects unparseable Turtle', () => {
    expect(() => parseTurtlePolicyShapes('this is not turtle')).toThrow(TurtlePolicyError);
  });

  it('rejects shapes without sh:targetClass', () => {
    expect(() =>
      parseTurtlePolicyShapes(
        `@prefix sh: <http://www.w3.org/ns/shacl#> .\n<urn:s> a sh:NodeShape ; sh:property [ sh:path <urn:sg:property:x> ; sh:minCount 1 ] .\n`,
      ),
    ).toThrow(/at least one shape with sh:targetClass/);
  });

  it('rejects explicit node targeting', () => {
    expect(() =>
      parseTurtlePolicyShapes(
        `@prefix sh: <http://www.w3.org/ns/shacl#> .\n<urn:s> a sh:NodeShape ; sh:targetClass <urn:sg:entity-type:SKILL_VERSION> ; sh:targetNode <urn:x> .\n`,
      ),
    ).toThrow(/must not use sh:targetNode/);
  });

  it('rejects complex or foreign paths', () => {
    expect(() =>
      parseTurtlePolicyShapes(
        `@prefix sh: <http://www.w3.org/ns/shacl#> .\n<urn:s> a sh:NodeShape ; sh:targetClass <urn:sg:entity-type:SKILL_VERSION> ; sh:property [ sh:path [ sh:inversePath <urn:sg:property:x> ] ; sh:minCount 1 ] .\n`,
      ),
    ).toThrow(/sh:path must be a simple IRI/);
    expect(() =>
      parseTurtlePolicyShapes(
        `@prefix sh: <http://www.w3.org/ns/shacl#> .\n<urn:s> a sh:NodeShape ; sh:targetClass <urn:sg:entity-type:SKILL_VERSION> ; sh:property [ sh:path <http://example.com/foreign> ; sh:minCount 1 ] .\n`,
      ),
    ).toThrow(/sh:path must be a simple IRI/);
  });

  it('rejects non-RE2 patterns at registration', () => {
    expect(() =>
      parseTurtlePolicyShapes(
        `@prefix sh: <http://www.w3.org/ns/shacl#> .\n<urn:s> a sh:NodeShape ; sh:targetClass <urn:sg:entity-type:SKILL_VERSION> ; sh:property [ sh:path <urn:sg:property:x> ; sh:pattern "(a)\\\\1" ] .\n`,
      ),
    ).toThrow(/not a valid RE2 regular expression/);
  });

  it('requires exactly one simple path on pattern property shapes', () => {
    expect(() =>
      parseTurtlePolicyShapes(
        `@prefix sh: <http://www.w3.org/ns/shacl#> .\n<urn:s> a sh:NodeShape ; sh:targetClass <urn:sg:entity-type:SKILL_VERSION> ; sh:property [ sh:pattern "^x" ] .\n`,
      ),
    ).toThrow(/exactly one simple sh:path/);
  });
});

describe('authored Turtle policy execution', () => {
  it('validates the focus publication and passes conforming graphs', async () => {
    expect(
      await validatePublicationGraphWithTurtleShapes({ graph: graph(), shapes_turtle: DESCRIPTION_TURTLE }),
    ).toEqual([]);
  });

  it('reports violations with authored messages and IRIs', async () => {
    const violations = await validatePublicationGraphWithTurtleShapes({
      graph: graph({ properties: { version: 1, artifact_sha256: 'abc123', source_path: 'x.md' } }),
      shapes_turtle: DESCRIPTION_TURTLE,
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      focusNode: 'urn:sg:skill-version:skill:demo@v1',
      resultPath: 'urn:sg:property:description',
      sourceConstraintComponent: 'MinCountConstraintComponent',
      message: 'description_required_by_shacl_policy',
      severity: 'Violation',
    });
  });

  it('never validates edge targets incidentally, even when they share the focus entity type', async () => {
    // Supersession/dependency edges commonly point at other versions of the
    // same entity type; class targeting must not leak onto those nodes.
    const violations = await validatePublicationGraphWithTurtleShapes({
      graph: graph({
        properties: { version: 1, artifact_sha256: 'abc123', source_path: 'x.md' },
        edges: [
          { predicate: 'sg:implementedBy', to_urn: 'urn:sg:artifact:sha256:abc123', to_entity_type: 'ARTIFACT' },
          { predicate: 'sg:dependsOnVersion', to_urn: 'urn:sg:skill-version:skill:other@v1', to_entity_type: 'SKILL_VERSION' },
        ],
      }),
      shapes_turtle: DESCRIPTION_TURTLE,
    });
    expect(violations).toHaveLength(1);
    expect(violations.every((violation) => violation.focusNode === 'urn:sg:skill-version:skill:demo@v1')).toBe(true);
  });

  it('keeps shapes targeting other entity types inert', async () => {
    const agentShapes = DESCRIPTION_TURTLE.replaceAll('SKILL_VERSION', 'AGENT_VERSION');
    expect(
      await validatePublicationGraphWithTurtleShapes({ graph: graph(), shapes_turtle: agentShapes }),
    ).toEqual([]);
  });

  it('checks edge target classes via sh:class', async () => {
    const shapes = `@prefix sh: <http://www.w3.org/ns/shacl#> .

<urn:policy:edges> a sh:NodeShape ;
    sh:targetClass <urn:sg:entity-type:SKILL_VERSION> ;
    sh:property [
        sh:path <urn:sg:predicate:sg-implementedBy> ;
        sh:minCount 1 ;
        sh:class <urn:sg:entity-type:ARTIFACT> ;
        sh:message "needs_artifact_target" ;
    ] .
`;
    const violations = await validatePublicationGraphWithTurtleShapes({
      graph: graph({ edges: [{ predicate: 'sg:implementedBy', to_urn: 'urn:x', to_entity_type: 'SKILL' }] }),
      shapes_turtle: shapes,
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      sourceConstraintComponent: 'ClassConstraintComponent',
      resultPath: 'urn:sg:predicate:sg-implementedBy',
      message: 'needs_artifact_target',
    });
  });

  it('strips sh:pattern before the engine and executes it with RE2', async () => {
    let capturedShapes = '';
    const fake = {
      engine: 'capturing-fake@0',
      validate: async (input: { data_nquads: string; shapes_turtle: string }) => {
        capturedShapes = input.shapes_turtle;
        return { conforms: true, results: [] };
      },
    };
    const shapes = `@prefix sh: <http://www.w3.org/ns/shacl#> .

<urn:policy:pattern> a sh:NodeShape ;
    sh:targetClass <urn:sg:entity-type:SKILL_VERSION> ;
    sh:property [
        sh:path <urn:sg:property:source_path> ;
        sh:pattern "^(a+)+$" ;
        sh:message "bad_source_path" ;
    ] .
`;
    const violations = await validatePublicationGraphWithTurtleShapes(
      {
        graph: graph({ properties: { version: 1, artifact_sha256: 'abc123', source_path: `${'a'.repeat(50_000)}b` } }),
        shapes_turtle: shapes,
      },
      fake,
    );
    expect(capturedShapes).not.toContain('shacl#pattern');
    expect(capturedShapes).not.toContain('(a+)+$');
    expect(violations).toHaveLength(1);

    const start = Date.now();
    const real = await validatePublicationGraphWithTurtleShapes({
      graph: graph({ properties: { version: 1, artifact_sha256: 'abc123', source_path: `${'a'.repeat(50_000)}b` } }),
      shapes_turtle: shapes,
    });
    expect(Date.now() - start).toBeLessThan(5_000);
    expect(real).toHaveLength(1);
    expect(real[0]).toMatchObject({
      sourceConstraintComponent: 'PatternConstraintComponent',
      resultPath: 'urn:sg:property:source_path',
      message: 'bad_source_path',
    });
  });

  it('propagates Warning severity as evidence', async () => {
    const shapes = `@prefix sh: <http://www.w3.org/ns/shacl#> .

<urn:policy:warn> a sh:NodeShape ;
    sh:targetClass <urn:sg:entity-type:SKILL_VERSION> ;
    sh:property [
        sh:path <urn:sg:property:license> ;
        sh:minCount 1 ;
        sh:severity sh:Warning ;
        sh:message "license_recommended" ;
    ] .
`;
    const violations = await validatePublicationGraphWithTurtleShapes({ graph: graph(), shapes_turtle: shapes });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ severity: 'Warning', message: 'license_recommended' });
  });

  it('orders violations deterministically', async () => {
    const shapes = `@prefix sh: <http://www.w3.org/ns/shacl#> .

<urn:policy:a> a sh:NodeShape ;
    sh:targetClass <urn:sg:entity-type:SKILL_VERSION> ;
    sh:property [ sh:path <urn:sg:property:license> ; sh:minCount 1 ; sh:message "license_missing" ] .

<urn:policy:b> a sh:NodeShape ;
    sh:targetClass <urn:sg:entity-type:SKILL_VERSION> ;
    sh:property [ sh:path <urn:sg:property:description> ; sh:in ( "documented" ) ; sh:message "not_documented" ] .
`;
    const first = await validatePublicationGraphWithTurtleShapes({ graph: graph(), shapes_turtle: shapes });
    const second = await validatePublicationGraphWithTurtleShapes({ graph: graph(), shapes_turtle: shapes });
    expect(second).toEqual(first);
    expect(first).toHaveLength(2);
  });
});

describe('builtin graph shape drift guard', () => {
  function legacyPathFor(graph: ValidationDataGraph, pathIriValue: string): string {
    if (pathIriValue.startsWith(SG_PROPERTY_PREFIX)) return pathIriValue.slice(SG_PROPERTY_PREFIX.length);
    const edge = graph.edges.find((candidate) => predicateIri(candidate.predicate) === pathIriValue);
    if (edge) return edge.predicate;
    // No matching edge in this graph (e.g. absent edges): decode the
    // best-effort label for builtin predicates (sg-implementedBy -> sg:implementedBy).
    const suffix = pathIriValue.slice(SG_PREDICATE_PREFIX.length);
    return suffix.replace('-', ':');
  }

  const graphs: ValidationDataGraph[] = [
    graph(),
    graph({ properties: { version: 1, artifact_sha256: 'abc' } }),
    graph({ properties: { version: 1, source_path: 'x.md' }, edges: [] }),
    graph({ properties: { version: 'one', artifact_sha256: 'abc', source_path: 'x.md' } }),
    graph({ edges: [{ predicate: 'sg:implementedBy', to_urn: 'urn:x', to_entity_type: 'SKILL' }] }),
    {
      focus_urn: 'urn:sg:agent-version:agent:demo@v1',
      entity_type: 'AGENT_VERSION',
      properties: { version: 1, artifact_sha256: 'abc', source_path: 'x.md' },
      edges: [{ predicate: 'sg:definedBy', to_urn: 'urn:x', to_entity_type: 'LOGICAL_ENTITY' }],
    },
  ];

  for (const [index, input] of graphs.entries()) {
    it(`builtin Turtle matches the legacy document on graph ${index}`, async () => {
      const legacy = (
        await validatePublicationGraphWithShacl({ graph: input, document: BUILTIN_GRAPH_SHAPE_DOCUMENT })
      )
        .map((violation) => [violation.resultPath ?? '', violation.sourceConstraintComponent, violation.message, violation.severity])
        .sort();
      const turtle = (
        await validatePublicationGraphWithTurtleShapes({ graph: input, shapes_turtle: BUILTIN_GRAPH_SHAPE_TURTLE })
      )
        .map((violation) => [
          legacyPathFor(input, violation.resultPath ?? ''),
          violation.sourceConstraintComponent,
          violation.message,
          violation.severity,
        ])
        .sort();
      expect(turtle).toEqual(legacy);
    });
  }

  it('records a stable builtin shapes digest', () => {
    expect(BUILTIN_GRAPH_SHAPE_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });
});
