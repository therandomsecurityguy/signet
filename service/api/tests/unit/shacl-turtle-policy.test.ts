import { describe, expect, it } from 'vitest';

import { buildAppDependencies } from '../../src/app/dependencies.js';
import { buildApp } from '../../src/app/server.js';
import { loadEnv } from '../../src/infrastructure/config/env.js';

async function buildTestApp() {
  const env = loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: ':memory:',
    REGISTRY_GRAPH_BACKEND: 'memory',
  });
  const deps = buildAppDependencies(env);
  await deps.ready();
  const { token } = await deps.apiKeys.create({ owner_label: 'Turtle Policy Writer' });
  return { app: buildApp(deps), token };
}

function authHeaders(token: string) {
  return { 'content-type': 'application/json', Authorization: `Bearer ${token}` };
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

const TRIVIAL_TURTLE = `@prefix sh: <http://www.w3.org/ns/shacl#> .

<urn:policy:trivial> a sh:NodeShape ;
    sh:targetClass <urn:sg:entity-type:SKILL_VERSION> ;
    sh:property [ sh:path <urn:sg:property:nonexistent> ; sh:minCount 0 ] .
`;

function artifactShaFromUrn(urn: string): string {
  return urn.split(':').slice(-1)[0] ?? '';
}

describe('authored Turtle policy packages (end to end)', () => {
  it('registers, enforces gates, and records SHACL validation reports', async () => {
    const { app, token } = await buildTestApp();

    const create = await app.request('/v1/policy-packages', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        policy_version: 'shacl-desc/v1',
        author: 'pablo',
        shapes_format: 'shacl-turtle',
        shapes: DESCRIPTION_TURTLE,
        require_validation: true,
      }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as {
      policy_package: { sha256: string; shapes_format: string; shapes: unknown };
      created: boolean;
    };
    expect(created.created).toBe(true);
    expect(created.policy_package.shapes_format).toBe('shacl-turtle');
    expect(created.policy_package.shapes).toBe(DESCRIPTION_TURTLE);

    // Idempotent re-register, then a conflicting payload for the same version.
    const recreate = await app.request('/v1/policy-packages', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        policy_version: 'shacl-desc/v1',
        author: 'pablo',
        shapes_format: 'shacl-turtle',
        shapes: DESCRIPTION_TURTLE,
        require_validation: true,
      }),
    });
    expect(recreate.status).toBe(200);
    expect(((await recreate.json()) as { created: boolean }).created).toBe(false);

    const conflict = await app.request('/v1/policy-packages', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        policy_version: 'shacl-desc/v1',
        author: 'pablo',
        shapes_format: 'shacl-turtle',
        shapes: DESCRIPTION_TURTLE.replace('description_required_by_shacl_policy', 'other_message'),
      }),
    });
    expect(conflict.status).toBe(409);

    // A draft bound to the turtle policy but missing the description.
    const draft = await app.request('/v1/skills/turtle-gated/drafts', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        author: 'pablo',
        artifact: { content: '# gated', original_path: 'skills/turtle-gated.md' },
        governance: { policy_version: 'shacl-desc/v1' },
      }),
    });
    expect(draft.status).toBe(200);

    const validate = await app.request('/v1/skills/turtle-gated/versions/1/validate', {
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
            validation_status: 'failed',
            validation_failures: ['description_required_by_shacl_policy'],
          },
        },
      },
    });

    // The validation report artifact records the W3C execution details.
    const version = await app.request('/v1/skills/turtle-gated/versions/1');
    expect(version.status).toBe(200);
    const versionBody = (await version.json()) as {
      governance_artifacts: Array<{ role: string; artifact_urn: string }>;
    };
    const reports = versionBody.governance_artifacts.filter((artifact) => artifact.role === 'validation_report');
    expect(reports.length).toBeGreaterThan(0);

    let sawShaclReport = false;
    let sawFailedReport = false;
    for (const report of reports) {
      const sha = artifactShaFromUrn(report.artifact_urn);
      const bytes = await app.request(`/v1/artifacts/${sha}`);
      expect(bytes.status).toBe(200);
      const record = (await bytes.json()) as {
        payload?: {
          validator?: string;
          engine?: string;
          conforms?: boolean;
          rdf?: {
            format?: string;
            canonical_rdf_sha256?: string;
            canonical_rdf_artifact_urn?: string;
            report?: { '@graph'?: Array<Record<string, unknown>> };
          };
          layers?: Array<{ layer: string; shapes_format?: string; shapes_sha256?: string; violations: Array<{ message: string }> }>;
        };
      };
      const payload = record.payload;
      // Draft-time placeholder and advisory LLM evidence artifacts carry no
      // shacl validator field; only validation-run reports do.
      if (payload?.validator !== 'shacl-v1') continue;
      sawShaclReport = true;
      expect(payload.engine).toBe('rdf-validate-shacl@0.6.5');
      if (payload.conforms) continue;
      sawFailedReport = true;
      const policyLayer = payload.layers?.find((layer) => layer.layer === 'policy');
      expect(policyLayer?.shapes_format).toBe('shacl-turtle');
      expect(policyLayer?.shapes_sha256).toBe(created.policy_package.sha256);
      expect(policyLayer?.violations.map((violation) => violation.message)).toContain(
        'description_required_by_shacl_policy',
      );

      // Standardized RDF export of the same report: sh:ValidationReport
      // JSON-LD + RDFC-1.0 canonical digest whose artifact bytes hash back.
      expect(payload.rdf?.format).toBe('jsonld');
      expect(payload.rdf?.canonical_rdf_sha256).toMatch(/^[0-9a-f]{64}$/);
      const rdfSha = payload.rdf?.canonical_rdf_sha256 as string;
      const canonicalNQuads = await app.request(`/v1/artifacts/${rdfSha}`);
      expect(canonicalNQuads.status).toBe(200);
      const canonicalText = await canonicalNQuads.text();
      expect(canonicalText).toContain('http://www.w3.org/ns/shacl#conforms');
      expect(canonicalText).toContain('http://www.w3.org/ns/shacl#MinCountConstraintComponent');
      const graph = payload.rdf?.report?.['@graph'] ?? [];
      const reportNode = graph.find(
        (node) => Array.isArray(node['@type']) && (node['@type'] as string[]).includes('http://www.w3.org/ns/shacl#ValidationReport'),
      );
      expect(reportNode).toBeDefined();
      expect(reportNode?.['sh:conforms']).toEqual([{ '@value': false }]);
      const results = graph.filter(
        (node) => Array.isArray(node['@type']) && (node['@type'] as string[]).includes('http://www.w3.org/ns/shacl#ValidationResult'),
      );
      expect(results.length).toBeGreaterThan(0);
      expect(results.some((node) => JSON.stringify(node['sh:resultMessage']).includes('description_required_by_shacl_policy'))).toBe(true);
    }
    expect(sawShaclReport).toBe(true);
    expect(sawFailedReport).toBe(true);

    // require_validation blocks publishing a never-validated draft.
    const gateDraft = await app.request('/v1/skills/turtle-gate-block/drafts', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        author: 'pablo',
        description: 'documented skill',
        artifact: { content: '# gate block', original_path: 'skills/turtle-gate-block.md' },
        governance: { policy_version: 'shacl-desc/v1' },
      }),
    });
    expect(gateDraft.status).toBe(200);
    const blockedPublish = await app.request('/v1/skills/turtle-gate-block/versions/1/publish', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ author: 'pablo' }),
    });
    expect(blockedPublish.status).toBe(409);
    await expect(blockedPublish.json()).resolves.toMatchObject({
      error: { code: 'SKILL_VERSION_VALIDATION_REQUIRED' },
    });

    // A conforming draft validates, publishes are gated, and certify works.
    const goodDraft = await app.request('/v1/skills/turtle-conforming/drafts', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        author: 'pablo',
        description: 'documented skill',
        artifact: { content: '# conforming', original_path: 'skills/turtle-conforming.md' },
        governance: { policy_version: 'shacl-desc/v1' },
      }),
    });
    expect(goodDraft.status).toBe(200);
    const goodValidate = await app.request('/v1/skills/turtle-conforming/versions/1/validate', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ author: 'pablo' }),
    });
    expect(goodValidate.status).toBe(200);
    await expect(goodValidate.json()).resolves.toMatchObject({
      result: { skill_version: { properties: { lifecycle_status: 'validated' } } },
    });
    const publish = await app.request('/v1/skills/turtle-conforming/versions/1/publish', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ author: 'pablo' }),
    });
    expect(publish.status).toBe(200);
    const certify = await app.request('/v1/skills/turtle-conforming/versions/1/certify', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ author: 'pablo' }),
    });
    expect(certify.status).toBe(200);
  });

  it('rejects invalid Turtle payloads with clear errors', async () => {
    const { app, token } = await buildTestApp();

    const invalidTurtle = await app.request('/v1/policy-packages', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        policy_version: 'bad-turtle/v1',
        author: 'pablo',
        shapes_format: 'shacl-turtle',
        shapes: 'not turtle at all',
      }),
    });
    expect(invalidTurtle.status).toBe(400);
    await expect(invalidTurtle.json()).resolves.toMatchObject({
      error: { code: 'POLICY_PACKAGE_INVALID' },
    });

    const targetNode = await app.request('/v1/policy-packages', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        policy_version: 'bad-target/v1',
        author: 'pablo',
        shapes_format: 'shacl-turtle',
        shapes: `@prefix sh: <http://www.w3.org/ns/shacl#> .\n<urn:s> a sh:NodeShape ; sh:targetClass <urn:sg:entity-type:SKILL_VERSION> ; sh:targetNode <urn:x> .\n`,
      }),
    });
    expect(targetNode.status).toBe(400);
    await expect(targetNode.json()).resolves.toMatchObject({
      error: { code: 'POLICY_PACKAGE_INVALID' },
    });

    const nonStringShapes = await app.request('/v1/policy-packages', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        policy_version: 'bad-shapes/v1',
        author: 'pablo',
        shapes_format: 'shacl-turtle',
        shapes: { shapes: [] },
      }),
    });
    expect(nonStringShapes.status).toBe(400);
    await expect(nonStringShapes.json()).resolves.toMatchObject({
      error: { code: 'VALIDATION_ERROR' },
    });

    const misplacedGates = await app.request('/v1/policy-packages', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        policy_version: 'bad-gates/v1',
        author: 'pablo',
        shapes: { shapes: [{ id: 's', target: { entity_type: 'SKILL_VERSION' }, properties: [] }] },
        require_validation: true,
      }),
    });
    expect(misplacedGates.status).toBe(400);
    await expect(misplacedGates.json()).resolves.toMatchObject({
      error: { code: 'VALIDATION_ERROR' },
    });
  });

  it('enforces human review gates carried at the turtle envelope level', async () => {
    const { app, token } = await buildTestApp();

    const create = await app.request('/v1/policy-packages', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        policy_version: 'turtle-review/v1',
        author: 'pablo',
        shapes_format: 'shacl-turtle',
        shapes: TRIVIAL_TURTLE,
        require_human_review: true,
      }),
    });
    expect(create.status).toBe(201);

    const draft = await app.request('/v1/skills/turtle-review-gated/drafts', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        author: 'pablo',
        description: 'documented skill',
        artifact: { content: '# review gated', original_path: 'skills/turtle-review-gated.md' },
        governance: { policy_version: 'turtle-review/v1' },
      }),
    });
    expect(draft.status).toBe(200);
    const validate = await app.request('/v1/skills/turtle-review-gated/versions/1/validate', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ author: 'pablo' }),
    });
    expect(validate.status).toBe(200);

    const publish = await app.request('/v1/skills/turtle-review-gated/versions/1/publish', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ author: 'pablo' }),
    });
    expect(publish.status).toBe(409);
    const publishBody = (await publish.json()) as { error: { code: string; message: string } };
    expect(publishBody.error.message).toContain('Human review approval is required by policy turtle-review/v1');
  });
});
