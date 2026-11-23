import { afterEach, describe, expect, it } from 'vitest';

import { buildAppDependencies } from '../../src/app/dependencies.js';
import { buildApp } from '../../src/app/server.js';
import { loadEnv } from '../../src/infrastructure/config/env.js';
import { closeSidecarServers, startNativeSidecar } from './support/native-sidecar.js';

afterEach(async () => {
  await closeSidecarServers();
});

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
  const { token } = await deps.apiKeys.create({ owner_label: 'Governance Transparency Writer' });
  return { app: buildApp(deps), token };
}

function authHeaders(token: string) {
  return { 'content-type': 'application/json', Authorization: `Bearer ${token}` };
}

async function publishSkill(app: ReturnType<typeof buildApp>, token: string, skillKey: string) {
  const draft = await app.request(`/v1/skills/${encodeURIComponent(skillKey)}/drafts`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      author: 'pablo',
      artifact: { content: `# ${skillKey}`, original_path: `skills/${skillKey}.md` },
    }),
  });
  expect(draft.status).toBe(200);
  for (const action of ['validate', 'publish']) {
    const step = await app.request(`/v1/skills/${encodeURIComponent(skillKey)}/versions/1/${action}`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ author: 'pablo' }),
    });
    expect(step.status).toBe(200);
  }
}

describe('governance ↔ companion transparency comparison', () => {
  it('reports consistent containment of the internal governance log in the companion log', async () => {
    const sidecar = await startNativeSidecar();
    const { app, token } = await buildTestApp({
      TESSERA_SIDECAR_URL: sidecar.baseUrl,
      TRANSPARENCY_APPEND_LOG_ID: 'signet-governance',
      TESSERA_LOG_PUBLIC_KEY: sidecar.publicKeyPem,
    });

    await publishSkill(app, token, 'skill:gov-transparency');

    const comparison = await app.request('/v1/governance-log/transparency-comparison');
    expect(comparison.status).toBe(200);
    const body = (await comparison.json()) as {
      internal_tree_size: number;
      companion_tree_size: number;
      internal_events_anchored: number;
      missing_anchor_count: number;
      companion_records_verified: number;
      companion_record_mismatches: unknown[];
      status: string;
    };
    expect(body.internal_tree_size).toBeGreaterThan(0);
    expect(body.companion_tree_size).toBeGreaterThanOrEqual(body.internal_tree_size);
    expect(body.missing_anchor_count).toBe(0);
    expect(body.internal_events_anchored).toBe(body.internal_tree_size);
    expect(body.companion_record_mismatches).toEqual([]);
    expect(body.companion_records_verified).toBe(body.companion_tree_size);
    expect(body.status).toBe('consistent');
  });

  it('fails closed when the companion log is not configured', async () => {
    const { app } = await buildTestApp();
    const comparison = await app.request('/v1/governance-log/transparency-comparison');
    expect(comparison.status).toBe(409);
    await expect(comparison.json()).resolves.toMatchObject({
      error: { code: 'TRANSPARENCY_RECONCILIATION_NOT_CONFIGURED' },
    });
  });

  it('flags a tampered companion leaf as divergent (claimed hash vs re-derived record hash)', async () => {
    const sidecar = await startNativeSidecar();
    const { app, token } = await buildTestApp({
      TESSERA_SIDECAR_URL: sidecar.baseUrl,
      TRANSPARENCY_APPEND_LOG_ID: 'signet-governance',
      TESSERA_LOG_PUBLIC_KEY: sidecar.publicKeyPem,
    });
    await publishSkill(app, token, 'skill:gov-transparency-tampered');

    // Tamper the first staged leaf object's claimed hash while leaving its
    // record bytes intact: the comparison re-derives the record leaf hash
    // and must report the lie instead of trusting the claimed value.
    const bucket = 'transparency-test-bucket';
    const leafKey = `${bucket}/tessera/tiles/test/signet-governance/leaves/0000000000.json`;
    const stored = sidecar.objects.get(leafKey);
    expect(stored).toBeDefined();
    const leaf = JSON.parse(stored?.toString('utf8') ?? '{}') as Record<string, unknown>;
    leaf['leaf_hash'] = 'f'.repeat(64);
    sidecar.objects.set(leafKey, Buffer.from(JSON.stringify(leaf), 'utf8'));

    const comparison = await app.request('/v1/governance-log/transparency-comparison');
    expect(comparison.status).toBe(200);
    const body = (await comparison.json()) as {
      status: string;
      companion_record_mismatches: Array<{ companion_leaf_index: number }>;
      missing_anchor_count: number;
    };
    expect(body.companion_record_mismatches).toHaveLength(1);
    expect(body.companion_record_mismatches[0]?.companion_leaf_index).toBe(0);
    expect(body.status).toBe('divergent');
  });
});
