import { describe, expect, it } from 'vitest';

import { buildAppDependencies } from '../../src/app/dependencies.js';
import { buildApp } from '../../src/app/server.js';
import { loadEnv } from '../../src/infrastructure/config/env.js';
import {
  skillVersionUrn,
  usageSignalUrn,
} from '../../../registry/domain/signet/db/graph/freeform/registry/urn.js';

async function buildTestApp() {
  const env = loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: ':memory:',
    REGISTRY_GRAPH_BACKEND: 'memory',
  });
  const deps = buildAppDependencies(env);
  await deps.ready();
  const { token } = await deps.apiKeys.create({ owner_label: 'Usage Writer' });
  return { app: buildApp(deps), token, deps };
}

function authHeaders(token: string) {
  return { 'content-type': 'application/json', Authorization: `Bearer ${token}` };
}

type TestApp = { request: (i: string, init?: RequestInit) => Promise<Response> | Response };

async function seedPublishedSkill(app: TestApp, token: string, skillKey: string) {
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
}

describe('usage signals (aggregate)', () => {
  it('counts verification encounters and artifact fetches on the API surfaces', async () => {
    const { app, token, deps } = await buildTestApp();
    await seedPublishedSkill(app, token, 'skill:usage-probe');
    const versionUrn = 'urn:sg:skill-version:skill:usage-probe@v1';

    // The verification endpoint is the surface `registry-operator verify
    // publication` (and every verification read) hits.
    for (let i = 0; i < 2; i += 1) {
      const res = await app.request('/v1/skills/skill%3Ausage-probe/versions/1/verification');
      expect(res.status).toBe(200);
    }
    const afterVerify = await deps.registryCore.getUsageSignal({ publication_urn: versionUrn });
    expect(afterVerify).toBeTruthy();
    expect((afterVerify?.verify_count ?? 0) + (afterVerify?.verify_failure_count ?? 0)).toBe(2);
    expect((afterVerify?.last_verified_at ?? afterVerify?.last_verify_failed_at) ?? null).toBeTruthy();

    const versionRes = await app.request('/v1/skills/skill%3Ausage-probe/versions/1');
    const version = (await versionRes.json()) as { artifacts: Array<{ sha256?: string }> };
    const sha = version.artifacts[0]?.sha256 ?? '';
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
    const bytes = await app.request(`/v1/artifacts/${sha}`);
    expect(bytes.status).toBe(200);
    const afterFetch = await deps.registryCore.getUsageSignal({ artifact_sha256: sha });
    expect(afterFetch?.artifact_fetch_count).toBe(1);
    expect(afterFetch?.last_fetched_at).toBeTruthy();
  });

  it('feeds the trust ranking as a bounded component and stays identity-free', async () => {
    const { app, token, deps } = await buildTestApp();
    await seedPublishedSkill(app, token, 'skill:usage-ranked');
    const versionUrn = 'urn:sg:skill-version:skill:usage-ranked@v1';

    for (let i = 0; i < 120; i += 1) {
      await deps.registryCore.recordUsageSignal({ publication_urn: versionUrn, signal: 'load' });
    }

    const listRes = await app.request('/v1/skills?sort=trust');
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as {
      skills: Array<{
        skill_key: string;
        trust: { usage_loads: number | null; usage_component: number; score: number };
      }>;
    };
    const summary = list.skills.find((entry) => entry.skill_key === 'skill:usage-ranked');
    expect(summary?.trust.usage_loads).toBe(120);
    expect(summary?.trust.usage_component).toBe(0.5);

    // Counts and timestamps only — no identities ever land on usage nodes.
    const node = await deps.graph.getNode(usageSignalUrn('version', versionUrn));
    expect(node).toBeTruthy();
    const keys = Object.keys(node?.properties ?? {});
    for (const forbidden of ['actor', 'author', 'principal', 'client_name', 'request_id', 'api_key_id']) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it('serves usage counts over the read endpoint and in recertification-queue evidence', async () => {
    const { app, token, deps } = await buildTestApp();
    await seedPublishedSkill(app, token, 'skill:usage-queued');
    const versionUrn = skillVersionUrn('skill:usage-queued', 1);

    for (let i = 0; i < 4; i += 1) {
      await deps.registryCore.recordUsageSignal({ publication_urn: versionUrn, signal: 'load' });
    }

    const res = await app.request(`/v1/usage-signals?publication_urn=${encodeURIComponent(versionUrn)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      usage: { kind: string; load_count: number; last_loaded_at: string | null } | null;
    };
    expect(body.usage?.kind).toBe('version');
    expect(body.usage?.load_count).toBe(4);
    expect(body.usage?.last_loaded_at).toBeTruthy();

    // Validation: exactly one target, and unknown targets are null (never an error).
    expect((await app.request('/v1/usage-signals')).status).toBe(400);
    expect(
      (await app.request(`/v1/usage-signals?publication_urn=x&artifact_sha256=${'a'.repeat(64)}`)).status,
    ).toBe(400);
    const unknown = await app.request(`/v1/usage-signals?publication_urn=${encodeURIComponent('urn:sg:skill-version:skill:nope@v1')}`);
    expect(unknown.status).toBe(200);
    expect(((await unknown.json()) as { usage: unknown }).usage).toBeNull();

    // Queue evidence (build plan 3.1 → 2.1): aging versions carry their loads.
    const versionNode = await deps.graph.getNode(versionUrn);
    expect(versionNode).toBeTruthy();
    const aged = { ...versionNode?.properties };
    for (const key of ['published_at', 'validated_at']) {
      if (typeof aged[key] === 'string') aged[key] = new Date(Date.now() - 300 * 86_400_000).toISOString();
    }
    await deps.graph.upsertNode({ urn: versionUrn, entity_type: 'SKILL_VERSION', properties: aged });
    const queueRes = await app.request('/v1/recertification/queue');
    expect(queueRes.status).toBe(200);
    const queue = (await queueRes.json()) as {
      items: Array<{ logical_key: string; usage_loads: number; last_loaded_at: string | null }>;
    };
    const item = queue.items.find((entry) => entry.logical_key === 'skill:usage-queued');
    expect(item?.usage_loads).toBe(4);
    expect(item?.last_loaded_at).toBeTruthy();
  });
});
