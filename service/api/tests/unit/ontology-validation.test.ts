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
  const { token } = await deps.apiKeys.create({ owner_label: 'Ontology Writer' });
  return { app: buildApp(deps), token };
}

const SKILL_AREA_ONTOLOGY = {
  kind: 'skill_area',
  concepts: [
    { id: 'data-processing', label: 'Data Processing' },
    { id: 'pii-handling', parents: ['data-processing'] },
    { id: 'public-data', parents: ['data-processing'] },
  ],
  disjoint: [['pii-handling', 'public-data']],
};

const REGISTRY_SHAPE_ONTOLOGY = {
  kind: 'registry_shape',
  concepts: [
    { id: 'logical-identity' },
    { id: 'publication-snapshot' },
  ],
  disjoint: [],
};

function authHeaders(token: string) {
  return { 'content-type': 'application/json', Authorization: `Bearer ${token}` };
}

describe('ontology packages', () => {
  it('registers, lists, and fetches ontology packages of both kinds', async () => {
    const { app, token } = await buildTestApp();

    const create = await app.request('/v1/ontology-packages', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        ontology_version: 'skill-area/v1',
        author: 'pablo',
        ontology: SKILL_AREA_ONTOLOGY,
        description: 'example skill-area ontology',
      }),
    });
    expect(create.status).toBe(201);
    await expect(create.json()).resolves.toMatchObject({
      ontology_package: { ontology_version: 'skill-area/v1', ontology_kind: 'skill_area' },
      created: true,
    });

    // Idempotent re-register.
    const recreate = await app.request('/v1/ontology-packages', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ ontology_version: 'skill-area/v1', author: 'pablo', ontology: SKILL_AREA_ONTOLOGY }),
    });
    expect(recreate.status).toBe(200);
    await expect(recreate.json()).resolves.toMatchObject({ created: false });

    // Conflicting content for the same version is rejected.
    const conflict = await app.request('/v1/ontology-packages', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        ontology_version: 'skill-area/v1',
        author: 'pablo',
        ontology: { kind: 'skill_area', concepts: [{ id: 'other' }], disjoint: [] },
      }),
    });
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({ error: { code: 'ONTOLOGY_PACKAGE_CONFLICT' } });

    // Invalid documents are rejected.
    const invalid = await app.request('/v1/ontology-packages', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ ontology_version: 'skill-area/v2', author: 'pablo', ontology: { kind: 'wrong' } }),
    });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({ error: { code: 'ONTOLOGY_PACKAGE_INVALID' } });

    // Registry-shape packages register as a separate kind.
    const registryShape = await app.request('/v1/ontology-packages', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ ontology_version: 'registry-shape/v1', author: 'pablo', ontology: REGISTRY_SHAPE_ONTOLOGY }),
    });
    expect(registryShape.status).toBe(201);
    await expect(registryShape.json()).resolves.toMatchObject({
      ontology_package: { ontology_kind: 'registry_shape' },
    });

    const get = await app.request('/v1/ontology-packages/skill-area%2Fv1');
    expect(get.status).toBe(200);
    await expect(get.json()).resolves.toMatchObject({ ontology: SKILL_AREA_ONTOLOGY });

    const missing = await app.request('/v1/ontology-packages/skill-area%2Fmissing');
    expect(missing.status).toBe(404);

    const list = await app.request('/v1/ontology-packages');
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { ontology_packages: Array<{ ontology_version: string }> };
    expect(listBody.ontology_packages.map((p) => p.ontology_version)).toEqual(
      expect.arrayContaining(['skill-area/v1', 'registry-shape/v1']),
    );
  });

  it('gates draft validation on claim binding and records de facto candidates', async () => {
    const { app, token } = await buildTestApp();
    expect(
      (
        await app.request('/v1/ontology-packages', {
          method: 'POST',
          headers: authHeaders(token),
          body: JSON.stringify({ ontology_version: 'skill-area/v1', author: 'pablo', ontology: SKILL_AREA_ONTOLOGY }),
        })
      ).status,
    ).toBe(201);

    // Draft with an unmapped claim: rejected, candidate recorded.
    const draft = await app.request('/v1/skills/skill:ontology-gated/drafts', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        author: 'pablo',
        artifact: { content: '# gated', original_path: 'skills/ontology-gated.md' },
        capability_claims: ['data-processing', 'teleportation'],
        governance: { ontology_version: 'skill-area/v1' },
      }),
    });
    expect(draft.status).toBe(200);

    const validate = await app.request('/v1/skills/skill:ontology-gated/versions/1/validate', {
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
            validation_failures: ['capability claim does not bind to a known concept: teleportation'],
          },
        },
      },
    });

    // Draft with disjoint claims: rejected even though every claim binds.
    const disjointDraft = await app.request('/v1/skills/skill:ontology-disjoint/drafts', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        author: 'pablo',
        artifact: { content: '# disjoint', original_path: 'skills/ontology-disjoint.md' },
        capability_claims: ['pii-handling', 'public-data'],
        governance: { ontology_version: 'skill-area/v1' },
      }),
    });
    expect(disjointDraft.status).toBe(200);
    const disjointValidate = await app.request('/v1/skills/skill:ontology-disjoint/versions/1/validate', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ author: 'pablo' }),
    });
    expect(disjointValidate.status).toBe(200);
    await expect(disjointValidate.json()).resolves.toMatchObject({
      result: {
        skill_version: {
          properties: {
            lifecycle_status: 'rejected',
            validation_failures: ['capability claims combine disjoint concepts: pii-handling + public-data'],
          },
        },
      },
    });

    // Conforming draft passes.
    const goodDraft = await app.request('/v1/skills/skill:ontology-conforming/drafts', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        author: 'pablo',
        artifact: { content: '# conforming', original_path: 'skills/ontology-conforming.md' },
        capability_claims: ['data-processing', 'pii-handling'],
        governance: { ontology_version: 'skill-area/v1' },
      }),
    });
    expect(goodDraft.status).toBe(200);
    const goodValidate = await app.request('/v1/skills/skill:ontology-conforming/versions/1/validate', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ author: 'pablo' }),
    });
    expect(goodValidate.status).toBe(200);
    await expect(goodValidate.json()).resolves.toMatchObject({
      result: { skill_version: { properties: { lifecycle_status: 'validated' } } },
    });
  });

  it('binds certification to a registered ontology package', async () => {
    const { app, token } = await buildTestApp();
    expect(
      (
        await app.request('/v1/ontology-packages', {
          method: 'POST',
          headers: authHeaders(token),
          body: JSON.stringify({ ontology_version: 'skill-area/v1', author: 'pablo', ontology: SKILL_AREA_ONTOLOGY }),
        })
      ).status,
    ).toBe(201);

    const draft = await app.request('/v1/skills/skill:ontology-certified/drafts', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        author: 'pablo',
        artifact: { content: '# certifiable', original_path: 'skills/ontology-certified.md' },
        capability_claims: ['data-processing'],
        governance: { ontology_version: 'skill-area/v1' },
      }),
    });
    expect(draft.status).toBe(200);
    expect(
      (
        await app.request('/v1/skills/skill:ontology-certified/versions/1/publish', {
          method: 'POST',
          headers: authHeaders(token),
          body: JSON.stringify({ author: 'pablo' }),
        })
      ).status,
    ).toBe(200);

    // Certify against an unregistered ontology version fails.
    const unbound = await app.request('/v1/skills/skill:ontology-certified/versions/1/certify', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ author: 'pablo', governance: { ontology_version: 'skill-area/missing' } }),
    });
    expect(unbound.status).toBe(404);
    await expect(unbound.json()).resolves.toMatchObject({ error: { code: 'ONTOLOGY_PACKAGE_NOT_FOUND' } });

    // Certify bound to the registered ontology package succeeds.
    const certify = await app.request('/v1/skills/skill:ontology-certified/versions/1/certify', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ author: 'pablo', governance: { ontology_version: 'skill-area/v1' } }),
    });
    expect(certify.status).toBe(200);
    await expect(certify.json()).resolves.toMatchObject({
      result: {
        skill_version: {
          properties: {
            lifecycle_status: 'certified',
            certification_ontology_version: 'skill-area/v1',
          },
        },
      },
    });
  });

  it('rejects subclass combinations of disjoint concepts across the hierarchy', async () => {
    const { app, token } = await buildTestApp();
    expect(
      (
        await app.request('/v1/ontology-packages', {
          method: 'POST',
          headers: authHeaders(token),
          body: JSON.stringify({
            ontology_version: 'hierarchy/v1',
            author: 'pablo',
            ontology: {
              kind: 'skill_area',
              concepts: [
                { id: 'analysis' },
                { id: 'reporting-base' },
                { id: 'transform-v2', parents: ['analysis'] },
                { id: 'report', parents: ['reporting-base'] },
              ],
              disjoint: [['analysis', 'reporting-base']],
            },
          }),
        })
      ).status,
    ).toBe(201);

    // Subclass claims on both disjoint sides: rejected with ancestor evidence.
    const draft = await app.request('/v1/skills/skill:hierarchy-disjoint/drafts', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        author: 'pablo',
        artifact: { content: '# hierarchy', original_path: 'skills/hierarchy-disjoint.md' },
        capability_claims: ['transform-v2', 'report'],
        governance: { ontology_version: 'hierarchy/v1' },
      }),
    });
    expect(draft.status).toBe(200);
    const validate = await app.request('/v1/skills/skill:hierarchy-disjoint/versions/1/validate', {
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
              'capability claims combine disjoint concepts: transform-v2 + report (via analysis + reporting-base)',
            ],
          },
        },
      },
    });

    // Claims on the SAME side of the hierarchy still validate.
    const siblingDraft = await app.request('/v1/skills/skill:hierarchy-sibling/drafts', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        author: 'pablo',
        artifact: { content: '# sibling', original_path: 'skills/hierarchy-sibling.md' },
        capability_claims: ['analysis', 'transform-v2'],
        governance: { ontology_version: 'hierarchy/v1' },
      }),
    });
    expect(siblingDraft.status).toBe(200);
    const siblingValidate = await app.request('/v1/skills/skill:hierarchy-sibling/versions/1/validate', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ author: 'pablo' }),
    });
    await expect(siblingValidate.json()).resolves.toMatchObject({
      result: { skill_version: { properties: { lifecycle_status: 'validated' } } },
    });
  });
});
