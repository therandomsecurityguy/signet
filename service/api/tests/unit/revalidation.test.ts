import { describe, expect, it } from 'vitest';

import { buildAppDependencies } from '../../src/app/dependencies.js';
import { buildApp } from '../../src/app/server.js';
import { loadEnv } from '../../src/infrastructure/config/env.js';
import {
  agentVersionUrn,
  skillVersionUrn,
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
  const { token } = await deps.apiKeys.create({ owner_label: 'Revalidation Writer' });
  return { app: buildApp(deps), token, deps };
}

function authHeaders(token: string) {
  return { 'content-type': 'application/json', Authorization: `Bearer ${token}` };
}

type TestApp = { request: (i: string, init?: RequestInit) => Promise<Response> | Response };
type TestDeps = Awaited<ReturnType<typeof buildTestApp>>['deps'];

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgoIso = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString();

async function seedPublishedSkill(app: TestApp, token: string, skillKey: string, actions: string[] = ['validate', 'publish']) {
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

async function seedPublishedAgent(app: TestApp, token: string, agentKey: string) {
  // Initial agent registration auto-publishes v1.
  const create = await app.request('/v1/agents', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      agent_key: agentKey,
      source_path: 'agents/revalidation.md',
      artifact: { content: '# agent v1', original_path: 'agents/revalidation.md' },
    }),
  });
  expect(create.status).toBe(201);
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

// Backdating a real version must age every verification timestamp: freshness
// measures from the newest one (revalidation > certification > publication >
// validation).
const ageVerification = (properties: Record<string, unknown>, days: number): Record<string, unknown> => {
  const next = { ...properties };
  for (const key of ['certified_at', 'revalidated_at', 'published_at', 'validated_at']) {
    if (typeof next[key] === 'string') next[key] = daysAgoIso(days);
  }
  return next;
};

async function queueOf(app: TestApp, query = '') {
  const res = await app.request(`/v1/recertification/queue${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as {
    items: Array<{
      publication_urn: string;
      logical_key: string;
      entity_type: string;
      recertification_state: string;
      reasons: string[];
      freshness: Record<string, unknown>;
    }>;
    total: number;
    due_count: number;
    approaching_count: number;
  };
}

describe('recertification queue and revalidation', () => {
  it('revalidate records the moment, refreshes freshness, and clears the queue', async () => {
    const { app, token, deps } = await buildTestApp();
    await seedPublishedSkill(app, token, 'skill:aged');
    await patchVersionNode(deps, skillVersionUrn('skill:aged', 1), (properties) => ageVerification(properties, 300));

    const before = await queueOf(app);
    expect(before.total).toBe(1);
    expect(before.items[0]).toMatchObject({
      logical_key: 'skill:aged',
      entity_type: 'SKILL_VERSION',
      recertification_state: 'due',
    });
    expect(before.items[0]?.reasons).toContain('aged');

    const res = await app.request('/v1/skills/skill%3Aaged/versions/1/revalidate', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ author: 'operator' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      task: { task: { properties: Record<string, unknown> } };
      result: { skill_version: { properties: Record<string, unknown> } };
    };
    expect(body.task.task.properties['operation']).toBe('revalidate');
    expect(body.result.skill_version.properties['revalidation_status']).toBe('passed');
    expect(typeof body.result.skill_version.properties['revalidated_at']).toBe('string');

    const versionRes = await app.request('/v1/skills/skill%3Aaged/versions/1');
    const version = (await versionRes.json()) as { freshness?: Record<string, unknown> };
    expect(version.freshness?.['freshness']).toBe('fresh');
    expect(version.freshness?.['verification_basis']).toBe('revalidated_at');
    expect(version.freshness?.['age_days']).toBe(0);

    const after = await queueOf(app);
    expect(after.total).toBe(0);
  });

  it('records failed revalidation as evidence without changing the lifecycle status', async () => {
    const { app, token, deps } = await buildTestApp();
    await seedPublishedSkill(app, token, 'skill:broken');
    await patchVersionNode(deps, skillVersionUrn('skill:broken', 1), (properties) => {
      const { source_path: _dropped, ...rest } = properties;
      return rest;
    });

    const res = await app.request('/v1/skills/skill%3Abroken/versions/1/revalidate', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ author: 'operator' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { skill_version: { properties: Record<string, unknown> } } };
    expect(body.result.skill_version.properties['revalidation_status']).toBe('failed');
    expect(body.result.skill_version.properties['lifecycle_status']).toBe('published');
    expect(body.result.skill_version.properties['revalidation_failures']).toContain('missing_source_path_evidence');

    const queue = await queueOf(app);
    const item = queue.items.find((entry) => entry.logical_key === 'skill:broken');
    expect(item?.recertification_state).toBe('due');
    expect(item?.reasons).toContain('revalidation_failed');
  });

  it('orders due before approaching (oldest first) and filters by state and type', async () => {
    const { app, token, deps } = await buildTestApp();
    await seedPublishedSkill(app, token, 'skill:older');
    await patchVersionNode(deps, skillVersionUrn('skill:older', 1), (properties) => ageVerification(properties, 200));
    await seedPublishedSkill(app, token, 'skill:younger');
    await patchVersionNode(deps, skillVersionUrn('skill:younger', 1), (properties) => ageVerification(properties, 100));
    await seedPublishedAgent(app, token, 'cursor:revalidation-agent');
    await patchVersionNode(deps, agentVersionUrn('cursor:revalidation-agent', 1), (properties) => ageVerification(properties, 250));

    const all = await queueOf(app);
    expect(all.total).toBe(3);
    expect(all.due_count).toBe(2);
    expect(all.approaching_count).toBe(1);
    expect(all.items.map((item) => item.logical_key)).toEqual([
      'cursor:revalidation-agent',
      'skill:older',
      'skill:younger',
    ]);
    expect(all.items[0]?.entity_type).toBe('AGENT_VERSION');
    expect(all.items[2]?.recertification_state).toBe('approaching');

    const due = await queueOf(app, '?state=due');
    expect(due.total).toBe(2);
    expect(due.approaching_count).toBe(0);

    const agentsOnly = await queueOf(app, '?entity_type=agent');
    expect(agentsOnly.total).toBe(1);
    expect(agentsOnly.items[0]?.logical_key).toBe('cursor:revalidation-agent');
  });

  it('runs jobs end to end: idempotent create, recorded execution, idempotent replay', async () => {
    const { app, token, deps } = await buildTestApp();
    await seedPublishedSkill(app, token, 'skill:job-target');
    await patchVersionNode(deps, skillVersionUrn('skill:job-target', 1), (properties) => ageVerification(properties, 400));

    const create = await app.request('/v1/revalidation-jobs', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ job_id: 'job-1', author: 'operator' }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as { created: boolean; revalidation_job: { properties: Record<string, unknown> } };
    expect(created.created).toBe(true);
    expect(created.revalidation_job.properties['status']).toBe('planned');
    expect(created.revalidation_job.properties['scope']).toBe('due');

    const again = await app.request('/v1/revalidation-jobs', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ job_id: 'job-1', author: 'operator' }),
    });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { created: boolean }).created).toBe(false);

    const conflicting = await app.request('/v1/revalidation-jobs', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ job_id: 'job-1', author: 'operator', limit: 5 }),
    });
    expect(conflicting.status).toBe(409);
    expect(((await conflicting.json()) as { error: { code: string } }).error.code).toBe(
      'REVALIDATION_JOB_CREATE_CONFLICT',
    );

    const execute = await app.request('/v1/revalidation-jobs/job-1/execute', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ author: 'operator' }),
    });
    expect(execute.status).toBe(200);
    const executed = (await execute.json()) as { revalidation_job: { properties: Record<string, unknown> } };
    const props = executed.revalidation_job.properties;
    expect(props['status']).toBe('completed');
    expect(props['candidate_count']).toBe(1);
    expect(props['passed_count']).toBe(1);
    expect(props['failed_count']).toBe(0);
    expect(props['skipped_count']).toBe(0);
    expect(String(props['results_sha256'])).toMatch(/^[0-9a-f]{64}$/);

    const replay = await app.request('/v1/revalidation-jobs/job-1/execute', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ author: 'operator' }),
    });
    expect(replay.status).toBe(200);
    const replayed = (await replay.json()) as { revalidation_job: { properties: Record<string, unknown> } };
    expect(replayed.revalidation_job.properties['executed_at']).toBe(props['executed_at']);

    const list = await app.request('/v1/revalidation-jobs');
    expect(((await list.json()) as { jobs: unknown[] }).jobs).toHaveLength(1);
    const get = await app.request('/v1/revalidation-jobs/job-1');
    expect(get.status).toBe(200);

    const after = await queueOf(app);
    expect(after.total).toBe(0);
  });

  it('excludes drafts and revoked versions; revalidate rejects drafts with a conflict', async () => {
    const { app, token, deps } = await buildTestApp();
    const create = await app.request('/v1/skills', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ skill_key: 'skill:drafty', artifact: { content: '# drafty' } }),
    });
    expect(create.status).toBe(201);
    const draft = await app.request('/v1/skills/skill%3Adrafty/drafts', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ author: 'seed', artifact: { content: '# drafty v1', original_path: 'skills/drafty.md' } }),
    });
    expect(draft.status).toBe(200);

    const rejected = await app.request('/v1/skills/skill%3Adrafty/versions/1/revalidate', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ author: 'operator' }),
    });
    expect(rejected.status).toBe(409);
    expect(((await rejected.json()) as { error: { code: string } }).error.code).toBe(
      'SKILL_VERSION_REVALIDATE_CONFLICT',
    );

    await seedPublishedSkill(app, token, 'skill:dead');
    await patchVersionNode(deps, skillVersionUrn('skill:dead', 1), (properties) => ageVerification(properties, 500));
    const revoke = await app.request('/v1/skills/skill%3Adead/versions/1/revoke', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ author: 'operator' }),
    });
    expect(revoke.status).toBe(200);

    const queue = await queueOf(app);
    expect(queue.total).toBe(0);
  });
});
