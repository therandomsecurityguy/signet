import { describe, expect, it } from 'vitest';

import { buildAppDependencies } from '../../src/app/dependencies.js';
import { buildApp } from '../../src/app/server.js';
import { loadEnv } from '../../src/infrastructure/config/env.js';
import { skillVersionUrn } from '../../../registry/domain/signet/db/graph/freeform/registry/urn.js';

async function buildTestApp() {
  const env = loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: ':memory:',
    REGISTRY_GRAPH_BACKEND: 'memory',
  });
  const deps = buildAppDependencies(env);
  await deps.ready();
  const { token } = await deps.apiKeys.create({ owner_label: 'Recertify Writer' });
  return { app: buildApp(deps), token, deps };
}

function authHeaders(token: string) {
  return { 'content-type': 'application/json', Authorization: `Bearer ${token}` };
}

type TestApp = { request: (i: string, init?: RequestInit) => Promise<Response> | Response };
type TestDeps = Awaited<ReturnType<typeof buildTestApp>>['deps'];

async function seedCertifiedSkill(
  app: TestApp,
  token: string,
  skillKey: string,
  expiresAt?: string,
) {
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
  for (const action of ['validate', 'publish']) {
    const res = await app.request(`/v1/skills/${encodeURIComponent(skillKey)}/versions/1/${action}`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ author: 'seed' }),
    });
    if (res.status !== 200) throw new Error(`${action}: ${res.status} ${await res.text()}`);
  }
  const certify = await app.request(`/v1/skills/${encodeURIComponent(skillKey)}/versions/1/certify`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      author: 'seed',
      ...(expiresAt ? { governance: { certification_expires_at: expiresAt } } : {}),
    }),
  });
  if (certify.status !== 200) throw new Error(`certify: ${certify.status} ${await certify.text()}`);
}

async function patchVersionNode(
  deps: TestDeps,
  urn: string,
  mutate: (properties: Record<string, unknown>) => Record<string, unknown>,
) {
  const node = await deps.graph.getNode(urn);
  if (!node) throw new Error(`node missing: ${urn}`);
  await deps.graph.upsertNode({ urn, entity_type: node.entity_type, properties: mutate({ ...node.properties }) });
}

describe('recertification', () => {
  it('renews the certification, replaces the expiry, and clears the queue', async () => {
    const { app, token } = await buildTestApp();
    await seedCertifiedSkill(app, token, 'skill:expired-cert', '2026-01-01T00:00:00.000Z');

    const before = (await (await app.request('/v1/skills/skill%3Aexpired-cert')).json()) as {
      active_version: { freshness?: Record<string, unknown>; skill_version: { properties: Record<string, unknown> } };
    };
    expect(before.active_version.freshness?.['freshness']).toBe('stale');
    expect(before.active_version.freshness?.['certification_expired']).toBe(true);
    const previousCertifiedAt = before.active_version.skill_version.properties['certified_at'];
    const queueBefore = (await (await app.request('/v1/recertification/queue')).json()) as { total: number };
    expect(queueBefore.total).toBe(1);

    const res = await app.request('/v1/skills/skill%3Aexpired-cert/versions/1/recertify', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        author: 'operator',
        governance: { certification_expires_at: '2027-06-01T00:00:00.000Z' },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      task: { task: { properties: Record<string, unknown> } };
      result: { skill_version: { properties: Record<string, unknown> } };
    };
    expect(body.task.task.properties['operation']).toBe('recertify');
    expect(body.task.task.properties['validation_status']).toBe('passed');
    const props = body.result.skill_version.properties;
    expect(props['certified']).toBe(true);
    expect(props['lifecycle_status']).toBe('certified');
    expect(props['certification_expires_at']).toBe('2027-06-01T00:00:00.000Z');
    expect(props['revalidation_status']).toBe('passed');
    expect(typeof props['revalidated_at']).toBe('string');
    expect(props['certified_at']).not.toBe(previousCertifiedAt);

    const after = (await (await app.request('/v1/skills/skill%3Aexpired-cert')).json()) as {
      active_version: { freshness?: Record<string, unknown> };
    };
    expect(after.active_version.freshness?.['freshness']).toBe('fresh');
    expect(after.active_version.freshness?.['verification_basis']).toBe('certified_at');
    expect(after.active_version.freshness?.['certification_expired']).toBe(false);
    expect(after.active_version.freshness?.['expires_in_days'] as number).toBeGreaterThan(0);

    const queueAfter = (await (await app.request('/v1/recertification/queue')).json()) as { total: number };
    expect(queueAfter.total).toBe(0);
  });

  it('a renewal without a new deadline carries no expiry', async () => {
    const { app, token } = await buildTestApp();
    await seedCertifiedSkill(app, token, 'skill:no-deadline', '2026-01-01T00:00:00.000Z');

    const res = await app.request('/v1/skills/skill%3Ano-deadline/versions/1/recertify', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ author: 'operator' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { skill_version: { properties: Record<string, unknown> } } };
    expect(body.result.skill_version.properties['certification_expires_at']).toBeUndefined();
    expect(body.result.skill_version.properties['certification_expired']).toBeUndefined();
  });

  it('a failing validation is recorded and the certification is NOT renewed', async () => {
    const { app, token, deps } = await buildTestApp();
    await seedCertifiedSkill(app, token, 'skill:broken-cert', '2027-01-01T00:00:00.000Z');
    const node = await deps.graph.getNode(skillVersionUrn('skill:broken-cert', 1));
    const previousCertifiedAt = node?.properties['certified_at'];
    await patchVersionNode(deps, skillVersionUrn('skill:broken-cert', 1), (properties) => {
      const { source_path: _dropped, ...rest } = properties;
      return rest;
    });

    const res = await app.request('/v1/skills/skill%3Abroken-cert/versions/1/recertify', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ author: 'operator' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      task: { task: { properties: Record<string, unknown> } };
      result: { skill_version: { properties: Record<string, unknown> } };
    };
    expect(body.task.task.properties['validation_status']).toBe('failed');
    const props = body.result.skill_version.properties;
    expect(props['revalidation_status']).toBe('failed');
    expect(props['revalidation_failures']).toContain('missing_source_path_evidence');
    expect(props['certified_at']).toBe(previousCertifiedAt);
    expect(props['certification_expires_at']).toBe('2027-01-01T00:00:00.000Z');
    expect(props['lifecycle_status']).toBe('certified');

    const queue = (await (await app.request('/v1/recertification/queue')).json()) as {
      items: Array<{ logical_key: string; reasons: string[] }>;
    };
    const item = queue.items.find((entry) => entry.logical_key === 'skill:broken-cert');
    expect(item?.reasons).toContain('revalidation_failed');
  });

  it('rejects recertification for uncertified versions', async () => {
    const { app, token } = await buildTestApp();
    const create = await app.request('/v1/skills', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ skill_key: 'skill:only-published', artifact: { content: '# x' } }),
    });
    expect(create.status).toBe(201);
    const draft = await app.request('/v1/skills/skill%3Aonly-published/drafts', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ author: 'seed', artifact: { content: '# x v1', original_path: 'skills/x.md' } }),
    });
    expect(draft.status).toBe(200);
    for (const action of ['validate', 'publish']) {
      const res = await app.request(`/v1/skills/skill%3Aonly-published/versions/1/${action}`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ author: 'seed' }),
      });
      expect(res.status).toBe(200);
    }
    const res = await app.request('/v1/skills/skill%3Aonly-published/versions/1/recertify', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ author: 'operator' }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('SKILL_VERSION_RECERTIFY_CONFLICT');
  });

  it('recertifies agent versions end to end', async () => {
    const { app, token } = await buildTestApp();
    const create = await app.request('/v1/agents', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        agent_key: 'cursor:recertify-agent',
        source_path: 'agents/recertify.md',
        artifact: { content: '# agent v1', original_path: 'agents/recertify.md' },
      }),
    });
    expect(create.status).toBe(201);
    const certify = await app.request('/v1/agents/cursor%3Arecertify-agent/versions/1/certify', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        author: 'seed',
        governance: { certification_expires_at: '2026-01-01T00:00:00.000Z' },
      }),
    });
    expect(certify.status).toBe(200);

    const res = await app.request('/v1/agents/cursor%3Arecertify-agent/versions/1/recertify', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ author: 'operator', note: 'annual renewal' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      task: { task: { properties: Record<string, unknown> } };
      result: { agent_version: { properties: Record<string, unknown> } };
    };
    expect(body.task.task.properties['operation']).toBe('recertify');
    const props = body.result.agent_version.properties;
    expect(props['certified']).toBe(true);
    expect(props['certification_expires_at']).toBeUndefined();
    expect(props['certification_note']).toBe('annual renewal');
    expect(props['revalidation_status']).toBe('passed');

    const details = (await (await app.request('/v1/agents/cursor%3Arecertify-agent')).json()) as {
      active_version: { freshness?: Record<string, unknown> };
    };
    expect(details.active_version.freshness?.['verification_basis']).toBe('certified_at');
    expect(details.active_version.freshness?.['freshness']).toBe('fresh');
  });
});
