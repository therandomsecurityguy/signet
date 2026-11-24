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
  const { token } = await deps.apiKeys.create({ owner_label: 'Trust Writer' });
  return { app: buildApp(deps), token };
}

function authHeaders(token: string) {
  return { 'content-type': 'application/json', Authorization: `Bearer ${token}` };
}

type TestApp = { request: (i: string, init?: RequestInit) => Promise<Response> | Response };

async function createSkill(app: TestApp, token: string, skillKey: string) {
  const res = await app.request('/v1/skills', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ skill_key: skillKey, artifact: { content: `# ${skillKey}` } }),
  });
  expect(res.status).toBe(201);
}

async function createAndTransition(app: TestApp, token: string, skillKey: string, actions: string[]) {
  const draft = await app.request(`/v1/skills/${encodeURIComponent(skillKey)}/drafts`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      author: 'seed',
      artifact: { content: `# ${skillKey} v1`, original_path: `skills/${skillKey.replace(':', '-')}.md` },
    }),
  });
  expect(draft.status).toBe(200);
  for (const action of actions) {
    const res = await app.request(`/v1/skills/${encodeURIComponent(skillKey)}/versions/1/${action}`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ author: 'seed' }),
    });
    expect(res.status, `${action} on ${skillKey}`).toBe(200);
  }
}

describe('trust-ranked list endpoints', () => {
  it('orders skills by lifecycle tier (then recency) and exposes the components', async () => {
    const { app, token } = await buildTestApp();

    await createSkill(app, token, 'skill:certified');
    await createAndTransition(app, token, 'skill:certified', ['validate', 'publish', 'certify']);
    await createSkill(app, token, 'skill:published');
    await createAndTransition(app, token, 'skill:published', ['validate', 'publish']);
    await createSkill(app, token, 'skill:bare');

    const res = await app.request('/v1/skills?sort=trust', { headers: authHeaders(token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      skills: Array<{ skill_key: string; trust?: { score: number; lifecycle_status: string; tier_weight: number } }>;
    };
    expect(body.skills.map((skill) => skill.skill_key)).toEqual([
      'skill:certified',
      'skill:published',
      'skill:bare',
    ]);

    const certified = body.skills[0];
    expect(certified?.trust).toMatchObject({ lifecycle_status: 'certified', tier_weight: 3 });
    expect(certified?.trust?.score).toBeGreaterThanOrEqual(30);
    const published = body.skills[1];
    expect(published?.trust).toMatchObject({ lifecycle_status: 'published', tier_weight: 2 });
    const bare = body.skills[2];
    expect(bare?.trust).toMatchObject({ lifecycle_status: 'none', tier_weight: 0, score: 0 });
  });

  it('pages after ranking, not before', async () => {
    const { app, token } = await buildTestApp();
    await createSkill(app, token, 'skill:aaa-certified');
    await createAndTransition(app, token, 'skill:aaa-certified', ['validate', 'publish', 'certify']);
    await createSkill(app, token, 'skill:zzz-bare');

    const page = await app.request('/v1/skills?sort=trust&limit=1&offset=1', { headers: authHeaders(token) });
    expect(page.status).toBe(200);
    const body = (await page.json()) as { skills: Array<{ skill_key: string }> };
    expect(body.skills.map((skill) => skill.skill_key)).toEqual(['skill:zzz-bare']);

    const first = await app.request('/v1/skills?sort=trust&limit=1', { headers: authHeaders(token) });
    const firstBody = (await first.json()) as { skills: Array<{ skill_key: string }> };
    expect(firstBody.skills.map((skill) => skill.skill_key)).toEqual(['skill:aaa-certified']);
  });

  it('leaves the default ordering and shape untouched without sort=trust', async () => {
    const { app, token } = await buildTestApp();
    await createSkill(app, token, 'skill:plain');

    const res = await app.request('/v1/skills', { headers: authHeaders(token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { skills: Array<Record<string, unknown>> };
    expect(body.skills).toHaveLength(1);
    expect(body.skills[0]).not.toHaveProperty('trust');
  });
});
