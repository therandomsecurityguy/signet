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
  const { token } = await deps.apiKeys.create({ owner_label: 'Freshness Writer' });
  return { app: buildApp(deps), token };
}

function authHeaders(token: string) {
  return { 'content-type': 'application/json', Authorization: `Bearer ${token}` };
}

type TestApp = { request: (i: string, init?: RequestInit) => Promise<Response> | Response };

async function seedVersion(app: TestApp, token: string, skillKey: string, actions: string[]) {
  const create = await app.request('/v1/skills', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ skill_key: skillKey, artifact: { content: `# ${skillKey}` } }),
  });
  expect(create.status).toBe(201);
  const draft = await app.request(`/v1/skills/${encodeURIComponent(skillKey)}/drafts`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      author: 'seed',
      artifact: { content: `# ${skillKey} v1`, original_path: `skills/${skillKey.replaceAll(':', '-')}.md` },
    }),
  });
  expect(draft.status).toBe(200);
  for (const action of actions) {
    const res = await app.request(`/v1/skills/${encodeURIComponent(skillKey)}/versions/1/${action}`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ author: 'seed' }),
    });
    if (res.status !== 200) {
      throw new Error(`${action} on ${skillKey}: ${res.status} ${await res.text()}`);
    }
  }
}

function summaryFreshness(body: unknown, skillKey: string) {
  const skills = (body as { skills: Array<{ skill_key: string; freshness?: Record<string, unknown> }> }).skills;
  return skills.find((skill) => skill.skill_key === skillKey)?.freshness;
}

describe('freshness on read surfaces', () => {
  it('carries freshness on ranked lists, search, details and version endpoints', async () => {
    const { app, token } = await buildTestApp();
    await seedVersion(app, token, 'skill:freshness-basic', ['validate', 'publish']);

    const listRes = await app.request('/v1/skills?sort=trust');
    expect(listRes.status).toBe(200);
    const summary = summaryFreshness(await listRes.json(), 'skill:freshness-basic');
    expect(summary).toBeTruthy();
    expect(summary?.['freshness']).toBe('fresh');
    expect(summary?.['verification_basis']).toBe('published_at');
    expect(summary?.['age_days']).toBe(0);
    expect(summary?.['certification_expired']).toBe(false);

    const searchRes = await app.request('/v1/search?query=freshness-basic');
    expect(searchRes.status).toBe(200);
    expect(summaryFreshness(await searchRes.json(), 'skill:freshness-basic')?.['freshness']).toBe('fresh');

    const detailsRes = await app.request('/v1/skills/skill%3Afreshness-basic');
    expect(detailsRes.status).toBe(200);
    const details = (await detailsRes.json()) as {
      active_version: { freshness?: Record<string, unknown> };
    };
    expect(details.active_version.freshness?.['freshness']).toBe('fresh');

    const versionsRes = await app.request('/v1/skills/skill%3Afreshness-basic/versions');
    expect(versionsRes.status).toBe(200);
    const versions = (await versionsRes.json()) as {
      versions: Array<{ freshness?: Record<string, unknown> }>;
    };
    expect(versions.versions[0]?.freshness?.['verification_basis']).toBe('published_at');

    const activeRes = await app.request('/v1/skills/skill%3Afreshness-basic/active');
    expect(activeRes.status).toBe(200);
    expect(((await activeRes.json()) as { freshness?: Record<string, unknown> }).freshness?.['freshness']).toBe(
      'fresh',
    );
  });

  it('flags an expired certification as stale regardless of age', async () => {
    const { app, token } = await buildTestApp();
    await seedVersion(app, token, 'skill:expired', ['validate', 'publish']);

    const certify = await app.request('/v1/skills/skill%3Aexpired/versions/1/certify', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        author: 'seed',
        governance: { certification_expires_at: '2026-01-01T00:00:00.000Z' },
      }),
    });
    expect(certify.status).toBe(200);

    const detailsRes = await app.request('/v1/skills/skill%3Aexpired');
    const details = (await detailsRes.json()) as {
      active_version: { freshness?: Record<string, unknown> };
    };
    const freshness = details.active_version.freshness;
    expect(freshness?.['freshness']).toBe('stale');
    expect(freshness?.['certification_expired']).toBe(true);
    expect(freshness?.['verification_basis']).toBe('certified_at');
    expect(freshness?.['certification_expires_at']).toBe('2026-01-01T00:00:00.000Z');
    expect(freshness?.['expires_in_days'] as number).toBeLessThan(0);
    expect(freshness?.['reasons'] as string[]).toContain('certification_expired');
  });

  it('omits freshness for drafts that were never verified', async () => {
    const { app, token } = await buildTestApp();
    await seedVersion(app, token, 'skill:drafty', []);

    const versionRes = await app.request('/v1/skills/skill%3Adrafty/versions/1');
    expect(versionRes.status).toBe(200);
    const version = (await versionRes.json()) as { freshness?: unknown };
    expect(version.freshness).toBeUndefined();

    const listRes = await app.request('/v1/skills?sort=trust');
    expect(summaryFreshness(await listRes.json(), 'skill:drafty')).toBeUndefined();
  });
});
