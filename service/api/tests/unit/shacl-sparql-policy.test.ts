import { describe, expect, it } from 'vitest';

import { buildAppDependencies } from '../../src/app/dependencies.js';
import { buildApp } from '../../src/app/server.js';
import { loadEnv } from '../../src/infrastructure/config/env.js';
import {
  validatePublicationGraphWithTurtleShapes,
} from '../../../registry/application/services/shacl-publication-validation.js';
import { createShaclEngineSparqlAdapter, SHACL_ENGINE_SPARQL_ENGINE_ID } from '../../../registry/application/services/shacl-engine-sparql-engine.js';
import type { ValidationDataGraph } from '../../../registry/application/services/shacl-like-validator.js';
import { parseTurtlePolicyShapes, TurtlePolicyError } from '../../../registry/application/services/shacl-turtle-policy.js';

async function buildTestApp() {
  const env = loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: ':memory:',
    REGISTRY_GRAPH_BACKEND: 'memory',
  });
  const deps = buildAppDependencies(env);
  await deps.ready();
  const { token } = await deps.apiKeys.create({ owner_label: 'SPARQL Policy Writer' });
  return { app: buildApp(deps), token };
}

function authHeaders(token: string) {
  return { 'content-type': 'application/json', Authorization: `Bearer ${token}` };
}

const SPARQL_POLICY_TURTLE = `@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix ex: <urn:example:> .

ex:ontology sh:declare [ sh:prefix "ex" ; sh:namespace "urn:example:"^^xsd:anyURI ] .

<urn:policy:no-todo> a sh:NodeShape ;
    sh:targetClass <urn:sg:entity-type:SKILL_VERSION> ;
    sh:sparql [
        sh:message "description must not contain TODO (focus {$this})" ;
        sh:prefixes ex:ontology ;
        sh:select """
            SELECT $this ?path ?value WHERE {
                $this <urn:sg:property:description> ?value .
                FILTER(CONTAINS(STR(?value), "TODO"))
                BIND(<urn:sg:property:description> AS ?path)
            }
        """ ;
    ] .
`;

const TARGET_POLICY_TURTLE = `@prefix sh: <http://www.w3.org/ns/shacl#> .

<urn:policy:target> a sh:NodeShape ;
    sh:target <urn:policy:all-skill-versions> ;
    sh:property [
        sh:path <urn:sg:property:description> ;
        sh:minCount 1 ;
        sh:message "description required by target policy" ;
    ] .

<urn:policy:all-skill-versions> a sh:SPARQLTarget ;
    sh:select "SELECT ?this WHERE { ?this a <urn:sg:entity-type:SKILL_VERSION> }" .
`;

function graph(overrides: Partial<ValidationDataGraph> = {}): ValidationDataGraph {
  return {
    focus_urn: 'urn:sg:skill-version:skill:demo@v1',
    entity_type: 'SKILL_VERSION',
    properties: { version: 1, description: 'fine' },
    edges: [],
    ...overrides,
  };
}

describe('authored Turtle policy registration (SPARQL conventions)', () => {
  it('accepts node-shape sh:sparql with prefixes and SPARQL-based targets', () => {
    expect(parseTurtlePolicyShapes(SPARQL_POLICY_TURTLE)).toEqual({ shape_count: 1 });
    expect(parseTurtlePolicyShapes(TARGET_POLICY_TURTLE)).toEqual({ shape_count: 1 });
  });

  it('rejects sh:sparql on property shapes', () => {
    expect(() =>
      parseTurtlePolicyShapes(`@prefix sh: <http://www.w3.org/ns/shacl#> .
<urn:s> a sh:NodeShape ; sh:targetClass <urn:sg:entity-type:SKILL_VERSION> ;
  sh:property [ sh:path <urn:sg:property:description> ;
    sh:sparql [ sh:select "SELECT $this WHERE { FILTER(false) }" ] ] .
`),
    ).toThrow(/sh:sparql on property shapes is not supported/);
  });

  it('rejects REGEX() in SPARQL (backtracking engine; sh:pattern owns regex)', () => {
    expect(() =>
      parseTurtlePolicyShapes(`@prefix sh: <http://www.w3.org/ns/shacl#> .
<urn:s> a sh:NodeShape ; sh:targetClass <urn:sg:entity-type:SKILL_VERSION> ;
  sh:sparql [ sh:select "SELECT $this WHERE { $this <urn:sg:property:description> ?v . FILTER(REGEX(STR(?v), \\"^(a+)+$\\")) }" ] .
`),
    ).toThrow(/REGEX\(\) in SPARQL/);
    expect(() =>
      parseTurtlePolicyShapes(`@prefix sh: <http://www.w3.org/ns/shacl#> .
<urn:s> a sh:NodeShape ; sh:target <urn:t> .
<urn:t> sh:select "SELECT ?this WHERE { FILTER(REGEX(STR(?this), \\"x\\")) }" .
`),
    ).toThrow(/REGEX\(\) in SPARQL/);
  });

  it('rejects SHACL-AF features the engine would silently ignore', () => {
    for (const feature of ['sh:rule', 'sh:function', 'sh:js']) {
      expect(() =>
        parseTurtlePolicyShapes(`@prefix sh: <http://www.w3.org/ns/shacl#> .
<urn:s> a sh:NodeShape ; sh:targetClass <urn:sg:entity-type:SKILL_VERSION> ;
  ${feature} [ <urn:p> "x" ] .
`),
      ).toThrow(TurtlePolicyError);
    }
  });

  it('rejects bare sh:target and unresolved prefix declarations', () => {
    expect(() =>
      parseTurtlePolicyShapes(`@prefix sh: <http://www.w3.org/ns/shacl#> .
<urn:s> a sh:NodeShape ; sh:target <urn:not-a-sparql-target> .
`),
    ).toThrow(/sh:target must reference a node declaring sh:select/);

    expect(() =>
      parseTurtlePolicyShapes(`@prefix sh: <http://www.w3.org/ns/shacl#> .
<urn:s> a sh:NodeShape ; sh:targetClass <urn:sg:entity-type:SKILL_VERSION> ;
  sh:sparql [ sh:prefixes <urn:missing> ; sh:select "SELECT $this WHERE { FILTER(false) }" ] .
`),
    ).toThrow(/sh:prefixes must reference a node with sh:declare/);

    expect(() =>
      parseTurtlePolicyShapes(`@prefix sh: <http://www.w3.org/ns/shacl#> .
<urn:declares> sh:declare [ sh:prefix "ex" ] .
<urn:s> a sh:NodeShape ; sh:targetClass <urn:sg:entity-type:SKILL_VERSION> ;
  sh:sparql [ sh:prefixes <urn:declares> ; sh:select "SELECT $this WHERE { FILTER(false) }" ] .
`),
    ).toThrow(/sh:declare entries need a sh:prefix string and an xsd:anyURI sh:namespace/);
  });
});

describe('hybrid SPARQL engine', () => {
  it('pins the recorded engine id to the package.json dependency', async () => {
    const { readFileSync } = await import('node:fs');
    const pkg = JSON.parse(
      readFileSync(new URL('../../../registry/package.json', import.meta.url), 'utf8'),
    ) as { dependencies: Record<string, string> };
    const version = SHACL_ENGINE_SPARQL_ENGINE_ID.replace('shacl-engine@', '').replace('+sparql', '');
    expect(pkg.dependencies['shacl-engine']).toBe(`^${version}`);
  });

  it('never silently ignores sh:sparql (plugin always loaded)', async () => {
    const adapter = await createShaclEngineSparqlAdapter();
    const report = await adapter.validate({
      data_nquads:
        '<urn:sg:skill-version:s@1> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <urn:sg:entity-type:SKILL_VERSION> .\n' +
        '<urn:sg:skill-version:s@1> <urn:sg:property:description> "has TODO inside" .\n',
      shapes_turtle: SPARQL_POLICY_TURTLE,
    });
    expect(report.conforms).toBe(false);
    expect(report.results).toHaveLength(1);
    expect(report.results[0]).toMatchObject({
      sourceConstraintComponent: 'SPARQLConstraintComponent',
      path: 'urn:sg:property:description',
      value: 'has TODO inside',
    });
    expect(report.results[0]?.message).toContain('focus <urn:sg:skill-version:s@1>');
  });

  it('produces the same verdicts as the default engine for core-only shapes', async () => {
    const coreShapes = `@prefix sh: <http://www.w3.org/ns/shacl#> .
<urn:s> a sh:NodeShape ; sh:targetClass <urn:sg:entity-type:SKILL_VERSION> ;
  sh:property [ sh:path <urn:sg:property:license> ; sh:minCount 1 ; sh:severity sh:Warning ; sh:message "license recommended" ] ;
  sh:property [ sh:path <urn:sg:property:description> ; sh:datatype <http://www.w3.org/2001/XMLSchema#string> ] ;
  sh:property [ sh:path <urn:sg:predicate:sg-implementedBy> ; sh:minCount 1 ; sh:class <urn:sg:entity-type:ARTIFACT> ] .
`;
    const cases: ValidationDataGraph[] = [
      graph(),
      graph({ properties: { version: 1 } }),
      graph({ edges: [{ predicate: 'sg:implementedBy', to_urn: 'urn:x', to_entity_type: 'SKILL' }] }),
    ];
    const hybrid = await createShaclEngineSparqlAdapter();
    for (const input of cases) {
      const viaDefault = await validatePublicationGraphWithTurtleShapes({ graph: input, shapes_turtle: coreShapes });
      const viaHybrid = await validatePublicationGraphWithTurtleShapes(
        { graph: input, shapes_turtle: coreShapes },
        hybrid,
      );
      const normalize = (violations: typeof viaDefault) =>
        violations.map((v) => [v.resultPath ?? '', v.sourceConstraintComponent, v.message, v.severity]).sort();
      expect(normalize(viaHybrid)).toEqual(normalize(viaDefault));
    }
  });

  it('keeps SPARQL-target validation focus-scoped (edge targets never validated)', async () => {
    const withEdgeTarget = graph({
      edges: [{ predicate: 'sg:dependsOnVersion', to_urn: 'urn:sg:skill-version:skill:other@v9', to_entity_type: 'SKILL_VERSION' }],
    });
    const violations = await validatePublicationGraphWithTurtleShapes({
      graph: withEdgeTarget,
      shapes_turtle: TARGET_POLICY_TURTLE,
    });
    // The focus has a description; the edge-target version does not — a
    // naive SPARQL target would validate it too and surface a violation.
    expect(violations).toEqual([]);
  });
});

describe('end to end: authored SPARQL policies through the API', () => {
  it('rejects a draft via sh:sparql, records the report, and accepts a conforming one', async () => {
    const { app, token } = await buildTestApp();

    const create = await app.request('/v1/policy-packages', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        policy_version: 'sparql-policy/v1',
        author: 'pablo',
        shapes_format: 'shacl-turtle',
        shapes: SPARQL_POLICY_TURTLE,
      }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as { policy_package: { sha256: string } };

    const draft = await app.request('/v1/skills/sparql-gated/drafts', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        author: 'pablo',
        description: 'contains TODO marker',
        artifact: { content: '# gated', original_path: 'skills/sparql-gated.md' },
        governance: { policy_version: 'sparql-policy/v1' },
      }),
    });
    expect(draft.status).toBe(200);
    const validate = await app.request('/v1/skills/sparql-gated/versions/1/validate', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ author: 'pablo' }),
    });
    expect(validate.status).toBe(200);
    await expect(validate.json()).resolves.toMatchObject({
      result: {
        skill_version: {
          properties: {
            lifecycle_status: 'rejected',
            validation_failures: [
              'description must not contain TODO (focus <urn:sg:skill-version:sparql-gated@v1>)',
            ],
          },
        },
      },
    });

    // The report carries the SPARQL component and its RDF export maps it
    // onto the SHACL component IRI.
    const version = await app.request('/v1/skills/sparql-gated/versions/1');
    const versionBody = (await version.json()) as {
      governance_artifacts: Array<{ role: string; sha256?: string; artifact_urn: string }>;
    };
    let reportRdfNQuads = '';
    let sawSparqlComponent = false;
    for (const ref of versionBody.governance_artifacts.filter((a) => a.role === 'validation_report' && a.sha256)) {
      const payload = (await (await app.request(`/v1/artifacts/${ref.sha256}`)).json()) as {
        payload?: {
          validator?: string;
          rdf?: { canonical_rdf_sha256?: string };
          layers?: Array<{ layer: string; engine?: string; violations: Array<{ sourceConstraintComponent: string }> }>;
        };
      };
      if (payload.payload?.validator !== 'shacl-v1') continue;
      const policyLayer = payload.payload.layers?.find((layer) => layer.layer === 'policy');
      expect(policyLayer?.engine).toBe(SHACL_ENGINE_SPARQL_ENGINE_ID);
      sawSparqlComponent = policyLayer?.violations.some(
        (violation) => violation.sourceConstraintComponent === 'SPARQLConstraintComponent',
      ) ?? false;
      if (payload.payload.rdf?.canonical_rdf_sha256) {
        reportRdfNQuads = await (
          await app.request(`/v1/artifacts/${payload.payload.rdf.canonical_rdf_sha256}`)
        ).text();
      }
      break;
    }
    expect(sawSparqlComponent).toBe(true);
    expect(reportRdfNQuads).toContain('http://www.w3.org/ns/shacl#SPARQLConstraintComponent');
    expect(created.policy_package.sha256).toMatch(/^[0-9a-f]{64}$/);

    const goodDraft = await app.request('/v1/skills/sparql-conforming/drafts', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        author: 'pablo',
        description: 'clean description',
        artifact: { content: '# ok', original_path: 'skills/sparql-conforming.md' },
        governance: { policy_version: 'sparql-policy/v1' },
      }),
    });
    expect(goodDraft.status).toBe(200);
    const goodValidate = await app.request('/v1/skills/sparql-conforming/versions/1/validate', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ author: 'pablo' }),
    });
    expect(goodValidate.status).toBe(200);
    await expect(goodValidate.json()).resolves.toMatchObject({
      result: { skill_version: { properties: { lifecycle_status: 'validated' } } },
    });
  });

  it('applies a SPARQL-target policy to the focus version only', async () => {
    const { app, token } = await buildTestApp();

    const create = await app.request('/v1/policy-packages', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        policy_version: 'sparql-target/v1',
        author: 'pablo',
        shapes_format: 'shacl-turtle',
        shapes: TARGET_POLICY_TURTLE,
      }),
    });
    expect(create.status).toBe(201);

    // v1: no description (would fail the target policy if validated).
    const first = await app.request('/v1/skills/target-state/drafts', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        author: 'pablo',
        artifact: { content: '# v1', original_path: 'skills/target-state.md' },
      }),
    });
    expect(first.status).toBe(200);

    // v2: has a description and depends on v1 (an edge-target version of the
    // same entity type that lacks one).
    const second = await app.request('/v1/skills/target-state/drafts', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        author: 'pablo',
        description: 'documented',
        artifact: { content: '# v2', original_path: 'skills/target-state.md' },
        governance: { policy_version: 'sparql-target/v1' },
        lineage: { upstream_skill_version_urns: ['urn:sg:skill-version:skill:target-state@v1'] },
      }),
    });
    expect(second.status).toBe(200);

    const validate = await app.request('/v1/skills/target-state/versions/2/validate', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ author: 'pablo' }),
    });
    expect(validate.status).toBe(200);
    await expect(validate.json()).resolves.toMatchObject({
      result: { skill_version: { properties: { lifecycle_status: 'validated' } } },
    });
  });
});
