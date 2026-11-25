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
  const { token } = await deps.apiKeys.create({ owner_label: 'Tags Writer' });
  return { app: buildApp(deps), token };
}

function authHeaders(token: string) {
  return { 'content-type': 'application/json', Authorization: `Bearer ${token}` };
}

type TestApp = { request: (i: string, init?: RequestInit) => Promise<Response> | Response };

async function createSkill(app: TestApp, token: string, skillKey: string, description: string) {
  const created = await app.request('/v1/skills', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ skill_key: skillKey, description, artifact: { content: `# ${skillKey}` } }),
  });
  expect(created.status).toBe(201);
}

describe('tag curation and filtering', () => {
  it('normalizes, stores, filters, and surfaces tags across list and search', async () => {
    const { app, token } = await buildTestApp();
    await createSkill(app, token, 'skill:alpha', 'Onboarding pipelines for teams.');
    await createSkill(app, token, 'skill:beta', 'Gardening tips.');

    const put = await app.request('/v1/skills/skill%3Aalpha/tags', {
      method: 'PUT',
      headers: authHeaders(token),
      body: JSON.stringify({ tags: ['Platform', 'onboarding', 'platform', '  security  '] }),
    });
    expect(put.status).toBe(200);
    const putBody = (await put.json()) as { skill_key: string; tags: string[] };
    // Normalized: case-insensitively deduped (first spelling wins), sorted.
    expect(putBody.tags).toEqual(['onboarding', 'Platform', 'security']);

    // List summaries carry tags; the tag filter matches case-insensitively.
    const filtered = await app.request('/v1/skills?tag=platform', { headers: authHeaders(token) });
    expect(filtered.status).toBe(200);
    const filteredBody = (await filtered.json()) as { skills: Array<{ skill_key: string; tags?: string[] }> };
    expect(filteredBody.skills.map((skill) => skill.skill_key)).toEqual(['skill:alpha']);
    expect(filteredBody.skills[0]?.tags).toEqual(['onboarding', 'Platform', 'security']);

    const missing = await app.request('/v1/skills?tag=missing', { headers: authHeaders(token) });
    expect(((await missing.json()) as { skills: unknown[] }).skills).toEqual([]);

    // Tag terms are discoverable through semantic search.
    const search = await app.request(
      `/v1/search?query=${encodeURIComponent('security incidents')}&mode=semantic`,
      { headers: authHeaders(token) },
    );
    const searchBody = (await search.json()) as { skills: Array<{ skill_key: string; tags?: string[] }> };
    expect(searchBody.skills.map((skill) => skill.skill_key)).toContain('skill:alpha');
    expect(searchBody.skills[0]?.tags).toContain('security');
  });

  it('rejects invalid tags, unknown entities, and anonymous writes', async () => {
    const { app, token } = await buildTestApp();
    await createSkill(app, token, 'skill:gamma', 'Anything.');

    const invalid = await app.request('/v1/skills/skill%3Agamma/tags', {
      method: 'PUT',
      headers: authHeaders(token),
      body: JSON.stringify({ tags: ['has spaces are fine here?'] }),
    });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({ error: { code: 'TAG_INVALID' } });

    const tooLong = await app.request('/v1/skills/skill%3Agamma/tags', {
      method: 'PUT',
      headers: authHeaders(token),
      body: JSON.stringify({ tags: ['a'.repeat(41)] }),
    });
    expect(tooLong.status).toBe(400);

    const missing = await app.request('/v1/skills/skill%3Amissing/tags', {
      method: 'PUT',
      headers: authHeaders(token),
      body: JSON.stringify({ tags: ['x'] }),
    });
    expect(missing.status).toBe(404);

    const anon = await app.request('/v1/skills/skill%3Agamma/tags', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tags: ['x'] }),
    });
    expect([401, 403]).toContain(anon.status);
  });
});
