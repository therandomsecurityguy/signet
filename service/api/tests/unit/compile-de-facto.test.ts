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
  const { token } = await deps.apiKeys.create({ owner_label: 'Compile Writer' });
  return { app: buildApp(deps), token };
}

function authHeaders(token: string) {
  return { 'content-type': 'application/json', Authorization: `Bearer ${token}` };
}

const SKILL_AREA = {
  kind: 'skill_area',
  concepts: [{ id: 'data-processing' }, { id: 'reporting', parents: ['data-processing'] }],
  disjoint: [],
};

const MARKDOWN = `---
name: skill:compiled
display_name: Compiled Skill
capabilities:
  - data-processing
  - teleportation
---

# Compiled Skill

A compiled skill.
`;

async function registerOntology(app: { request: (i: string, init?: RequestInit) => Promise<Response> | Response }, token: string) {
  const res = await app.request('/v1/ontology-packages', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ ontology_version: 'skill-area/v1', author: 'pablo', ontology: SKILL_AREA }),
  });
  expect(res.status).toBe(201);
}

describe('semantic compiler ingestion', () => {
  it('compiles markdown and maps claims against the skill-area ontology', async () => {
    const { app, token } = await buildTestApp();
    await registerOntology(app, token);

    const compile = await app.request('/v1/compile/skill', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        source_type: 'markdown',
        content: MARKDOWN,
        author: 'pablo',
        ontology_version: 'skill-area/v1',
      }),
    });
    expect(compile.status).toBe(200);
    await expect(compile.json()).resolves.toMatchObject({
      compiled: {
        skill_key: 'skill:compiled',
        display_name: 'Compiled Skill',
        capability_claims: ['data-processing', 'teleportation'],
      },
      ontology_mapping: {
        ontology_version: 'skill-area/v1',
        ontology_package_resolved: true,
        mapped: ['data-processing'],
        unmapped: ['teleportation'],
      },
    });
  });

  it('compiles tool manifests', async () => {
    const { app, token } = await buildTestApp();
    const compile = await app.request('/v1/compile/skill', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        source_type: 'tool_manifest',
        content: JSON.stringify({ name: 'skill:manifest', capabilities: ['reporting'], tools: [{ name: 'Data Processing' }] }),
        author: 'pablo',
      }),
    });
    expect(compile.status).toBe(200);
    await expect(compile.json()).resolves.toMatchObject({
      compiled: { skill_key: 'skill:manifest', capability_claims: ['reporting', 'data-processing'] },
      ontology_mapping: { ontology_package_resolved: false },
    });
  });

  it('creates drafts from compiled source and records de facto candidates at validation', async () => {
    const { app, token } = await buildTestApp();
    await registerOntology(app, token);

    const compile = await app.request('/v1/compile/skill', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        source_type: 'markdown',
        content: MARKDOWN,
        author: 'pablo',
        ontology_version: 'skill-area/v1',
        create_draft: true,
      }),
    });
    expect(compile.status).toBe(200);
    const body = (await compile.json()) as {
      draft?: { result: { skill_version: { properties: Record<string, unknown> } } };
    };
    expect(body.draft?.result.skill_version.properties['capability_claims']).toEqual([
      'data-processing',
      'teleportation',
    ]);
    expect(body.draft?.result.skill_version.properties['ontology_version']).toBe('skill-area/v1');

    // Validation rejects the unmapped claim and records it as a de facto term.
    const validate = await app.request('/v1/skills/skill:compiled/versions/1/validate', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ author: 'pablo' }),
    });
    expect(validate.status).toBe(200);
    await expect(validate.json()).resolves.toMatchObject({
      result: { skill_version: { properties: { lifecycle_status: 'rejected' } } },
    });

    const terms = await app.request('/v1/de-facto-terms?status=candidate');
    expect(terms.status).toBe(200);
    const termsBody = (await terms.json()) as {
      terms: Array<{ term: string; seen_count: number; example_publication_urns: string[] }>;
    };
    const teleportation = termsBody.terms.find((t) => t.term === 'teleportation');
    expect(teleportation).toBeDefined();
    expect(teleportation?.seen_count).toBeGreaterThanOrEqual(1);
    expect(teleportation?.example_publication_urns).toContain('urn:sg:skill-version:skill:compiled@v1');
  });

  it('reviews de facto terms: reject, promote with normative incorporation, and conflict rules', async () => {
    const { app, token } = await buildTestApp();
    await registerOntology(app, token);

    // Seed two candidates via compile + draft + validate.
    for (const [skillKey, claim] of [
      ['skill:cand-a', 'quantum-sort'],
      ['skill:cand-b', 'teleportation'],
    ] as const) {
      const markdown = `---\nname: ${skillKey}\ncapabilities: [${claim}]\n---\n# X\n`;
      const compile = await app.request('/v1/compile/skill', {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({
          source_type: 'markdown',
          content: markdown,
          author: 'pablo',
          ontology_version: 'skill-area/v1',
          create_draft: true,
        }),
      });
      expect(compile.status).toBe(200);
      const validate = await app.request(`/v1/skills/${encodeURIComponent(skillKey)}/versions/1/validate`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ author: 'pablo' }),
      });
      expect(validate.status).toBe(200);
    }

    // Reject path.
    const reject = await app.request('/v1/de-facto-terms/quantum-sort/review', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ action: 'reject', author: 'dana' }),
    });
    expect(reject.status).toBe(200);
    await expect(reject.json()).resolves.toMatchObject({
      term: 'quantum-sort',
      status: 'rejected',
      reviewed_by: 'dana',
    });

    // Re-reviewing is a conflict.
    const rereview = await app.request('/v1/de-facto-terms/quantum-sort/review', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ action: 'reject', author: 'dana' }),
    });
    expect(rereview.status).toBe(409);

    // Promotion requires source and target ontology versions.
    const missingVersions = await app.request('/v1/de-facto-terms/teleportation/review', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ action: 'promote', author: 'dana' }),
    });
    expect(missingVersions.status).toBe(400);

    // Promotion appends the concept to a NEW ontology package version.
    const promote = await app.request('/v1/de-facto-terms/teleportation/review', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        action: 'promote',
        author: 'dana',
        source_ontology_version: 'skill-area/v1',
        target_ontology_version: 'skill-area/v2',
      }),
    });
    expect(promote.status).toBe(200);
    await expect(promote.json()).resolves.toMatchObject({
      term: 'teleportation',
      status: 'promoted',
      reviewed_by: 'dana',
      promoted_into_ontology_version: 'skill-area/v2',
    });

    // The new package version contains the promoted concept; the source is unchanged.
    const v2 = await app.request('/v1/ontology-packages/skill-area%2Fv2');
    expect(v2.status).toBe(200);
    const v2Body = (await v2.json()) as { ontology: { concepts: Array<{ id: string }> } };
    expect(v2Body.ontology.concepts.map((c) => c.id)).toContain('teleportation');
    const v1 = await app.request('/v1/ontology-packages/skill-area%2Fv1');
    const v1Body = (await v1.json()) as { ontology: { concepts: Array<{ id: string }> } };
    expect(v1Body.ontology.concepts.map((c) => c.id)).not.toContain('teleportation');

    // Status filters work.
    const promoted = await app.request('/v1/de-facto-terms?status=promoted');
    const promotedBody = (await promoted.json()) as { terms: Array<{ term: string }> };
    expect(promotedBody.terms.map((t) => t.term)).toEqual(['teleportation']);
  });
});
