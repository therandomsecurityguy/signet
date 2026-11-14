import { describe, expect, it } from 'vitest';

import { buildAppDependencies } from '../../src/app/dependencies.js';
import { buildApp } from '../../src/app/server.js';
import { loadEnv } from '../../src/infrastructure/config/env.js';

async function buildTestApp(overrides: NodeJS.ProcessEnv = {}) {
  const env = loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: ':memory:',
    REGISTRY_GRAPH_BACKEND: 'memory',
    ...overrides,
  });
  const deps = buildAppDependencies(env);
  await deps.ready();
  return { app: buildApp(deps), deps };
}

const POLICY_BODY = { policy_version: 'test-policy/v1', author: 'tester', shapes: { shapes: [] } };
const ONTOLOGY_BODY = { kind: 'skill_area', version: 'test/v1', concepts: [], disjoint: [] };
const COMPILE_BODY = { content: '# skill', content_format: 'markdown' };
const REVIEW_BODY = { action: 'promote' };

const UNAUTHENTICATED_WRITES: ReadonlyArray<[path: string, body: unknown]> = [
  ['/v1/policy-packages', POLICY_BODY],
  ['/v1/ontology-packages', ONTOLOGY_BODY],
  ['/v1/compile/skill', COMPILE_BODY],
  ['/v1/de-facto-terms/some-term/review', REVIEW_BODY],
];

describe('write route auth coverage', () => {
  it('rejects unauthenticated writes on governance routes', async () => {
    const { app } = await buildTestApp();
    for (const [path, body] of UNAUTHENTICATED_WRITES) {
      const response = await app.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(response.status, `expected 401 for POST ${path}`).toBe(401);
    }
  });

  it('enforces fine-grained write scopes by default on the governance routes', async () => {
    const { app, deps } = await buildTestApp();

    const { token: readToken } = await deps.apiKeys.create({
      owner_label: 'read-only-key',
      scopes: ['read'],
    });
    const denied = await app.request('/v1/policy-packages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${readToken}` },
      body: JSON.stringify(POLICY_BODY),
    });
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toMatchObject({ error: { code: 'INSUFFICIENT_SCOPE' } });

    const { token: policyToken } = await deps.apiKeys.create({
      owner_label: 'policy-writer-key',
      scopes: ['policies:write'],
    });
    const allowed = await app.request('/v1/policy-packages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${policyToken}` },
      body: JSON.stringify(POLICY_BODY),
    });
    expect(allowed.status).not.toBe(403);
  });

  it('audits denied writes on the previously unguarded governance routes', async () => {
    const { app, deps } = await buildTestApp();

    const db = await deps.db.getDb();
    const countFailures = async () =>
      Number(
        (
          (await db.all("SELECT COUNT(*) AS count FROM audit_events WHERE policy_reason = 'missing_bearer'")) as Array<{
            count: number;
          }>
        )[0]?.count ?? 0,
      );

    const before = await countFailures();
    await app.request('/v1/ontology-packages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ONTOLOGY_BODY),
    });
    expect(await countFailures()).toBeGreaterThan(before);
  });
});
