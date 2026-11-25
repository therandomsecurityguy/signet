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
  const { token } = await deps.apiKeys.create({ owner_label: 'Search Writer' });
  return { app: buildApp(deps), token };
}

function authHeaders(token: string) {
  return { 'content-type': 'application/json', Authorization: `Bearer ${token}` };
}

type TestApp = { request: (i: string, init?: RequestInit) => Promise<Response> | Response };

async function seedPublishedSkill(
  app: TestApp,
  token: string,
  skillKey: string,
  input: { description: string; capability_claims?: string[] },
) {
  const created = await app.request('/v1/skills', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ skill_key: skillKey, description: input.description, artifact: { content: `# ${skillKey}` } }),
  });
  expect(created.status).toBe(201);

  const draft = await app.request(`/v1/skills/${encodeURIComponent(skillKey)}/drafts`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      author: 'seed',
      ...(input.capability_claims?.length ? { capability_claims: input.capability_claims } : {}),
      artifact: { content: `# ${skillKey} v1`, original_path: `skills/${skillKey.replace(':', '-')}.md` },
    }),
  });
  expect(draft.status).toBe(200);

  for (const action of ['validate', 'publish']) {
    const res = await app.request(`/v1/skills/${encodeURIComponent(skillKey)}/versions/1/${action}`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ author: 'seed' }),
    });
    expect(res.status, `${action} on ${skillKey}`).toBe(200);
  }
}

interface SearchBody {
  query: string;
  mode: string;
  skills: Array<{
    skill_key: string;
    trust?: { lifecycle_status: string };
    match: { mode: string; score: number; matched_claims: string[]; matched_terms: string[]; phrase_match: boolean };
  }>;
  agents: Array<{ agent_key: string }>;
}

describe('registry search endpoint', () => {
  it('matches capability claims in semantic mode with relevance-first ordering', async () => {
    const { app, token } = await buildTestApp();
    await seedPublishedSkill(app, token, 'skill:claims', {
      description: 'Data workflows for regulated buckets.',
      capability_claims: ['pii-handling'],
    });
    await seedPublishedSkill(app, token, 'skill:phrase', {
      description: 'Handles PII handling pipelines daily.',
    });
    await seedPublishedSkill(app, token, 'skill:unrelated', {
      description: 'Gardening tips for balcony tomatoes.',
    });

    const res = await app.request(
      `/v1/search?query=${encodeURIComponent('PII handling pipelines')}&mode=semantic`,
      { headers: authHeaders(token) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchBody;
    expect(body.mode).toBe('semantic');
    expect(body.skills.map((skill) => skill.skill_key)).toEqual(['skill:phrase', 'skill:claims']);
    expect(body.skills[0]?.match).toMatchObject({ mode: 'semantic', phrase_match: true });
    expect(body.skills[1]?.match.matched_claims).toEqual(['pii-handling']);
    // Trust components ride along in every mode.
    expect(body.skills[0]?.trust).toMatchObject({ lifecycle_status: 'published' });
    expect(body.skills[0]?.match.score).toBeGreaterThan(body.skills[1]?.match.score ?? 0);
  });

  it('keeps substring behavior for the default keyword mode', async () => {
    const { app, token } = await buildTestApp();
    await seedPublishedSkill(app, token, 'skill:gardening', {
      description: 'Balcony tomatoes.',
    });

    const res = await app.request(`/v1/search?query=${encodeURIComponent('Balcony tomatoes')}`, {
      headers: authHeaders(token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchBody;
    expect(body.mode).toBe('keyword');
    expect(body.skills.map((skill) => skill.skill_key)).toEqual(['skill:gardening']);
    expect(body.skills[0]?.match).toMatchObject({ mode: 'keyword', score: 1, phrase_match: true });
  });

  it('honors type filters, limits, and rejects empty queries', async () => {
    const { app, token } = await buildTestApp();
    await seedPublishedSkill(app, token, 'skill:one', { description: 'alpha beta' });
    await seedPublishedSkill(app, token, 'skill:two', { description: 'alpha gamma' });

    const limited = await app.request(
      `/v1/search?query=${encodeURIComponent('alpha')}&type=skill&limit=1`,
      { headers: authHeaders(token) },
    );
    const limitedBody = (await limited.json()) as SearchBody;
    expect(limitedBody.skills).toHaveLength(1);
    expect(limitedBody.agents).toHaveLength(0);

    const invalid = await app.request('/v1/search?query=', { headers: authHeaders(token) });
    expect(invalid.status).toBe(400);
  });
});
