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
    TIME_AWARE_GRAPH_BACKEND: 'memory',
  });
  const deps = buildAppDependencies(env);
  await deps.ready();
  const { token } = await deps.apiKeys.create({ owner_label: 'GC Writer' });
  return { app: buildApp(deps), deps, token };
}

describe('durable GC job seam', () => {
  it('creates and executes a durable GC job over HTTP', async () => { 
    const { app, deps, token } = await buildTestApp();
    const headers = { 'content-type': 'application/json', Authorization: `Bearer ${token}` };

    const root = await deps.timeAwareCore.createRetentionRoot({
      root_id: 'root-1',
      root_kind: 'workspace',
      description: 'retention root for gc test',
    });
    expect(root.created).toBe(true);

    const create = await app.request('/v1/time-aware/gc-jobs', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        job_id: 'gc-job-1',
        author: 'pablo',
        retention_root_ids: ['root-1'],
        grace_period_days: 30,
      }),
    });
    expect(create.status).toBe(201);
    await expect(create.json()).resolves.toMatchObject({
      gc_job: {
        properties: {
          job_id: 'gc-job-1',
          status: 'planned',
          grace_period_days: 30,
        },
      },
      created: true,
    });

    // Idempotent re-create.
    const recreate = await app.request('/v1/time-aware/gc-jobs', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        job_id: 'gc-job-1',
        author: 'pablo',
        retention_root_ids: ['root-1'],
        grace_period_days: 30,
      }),
    });
    expect(recreate.status).toBe(200);
    await expect(recreate.json()).resolves.toMatchObject({ created: false });

    // Execute: durable non-destructive plan record.
    const execute = await app.request('/v1/time-aware/gc-jobs/gc-job-1/execute', {
      method: 'POST',
      headers,
      body: JSON.stringify({ author: 'pablo' }),
    });
    expect(execute.status).toBe(200);
    await expect(execute.json()).resolves.toMatchObject({
      gc_job: {
        properties: {
          job_id: 'gc-job-1',
          status: 'completed',
          executed_by: 'pablo',
          execution_mode: 'plan_only',
          analyzed_root_count: 1,
        },
      },
    });

    // Execution is idempotent.
    const reexecute = await app.request('/v1/time-aware/gc-jobs/gc-job-1/execute', {
      method: 'POST',
      headers,
      body: JSON.stringify({ author: 'pablo' }),
    });
    expect(reexecute.status).toBe(200);
    await expect(reexecute.json()).resolves.toMatchObject({
      gc_job: { properties: { status: 'completed' } },
    });

    // The job is listed through the read plane.
    const list = await app.request('/v1/time-aware/gc-jobs');
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { gc_jobs: Array<{ properties: Record<string, unknown> }> };
    expect(listBody.gc_jobs.some((job) => job.properties['job_id'] === 'gc-job-1')).toBe(true);
  });

  it('returns 404 when executing an unknown GC job', async () => {
    const { app, token } = await buildTestApp();
    const execute = await app.request('/v1/time-aware/gc-jobs/missing/execute', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ author: 'pablo' }),
    });
    expect(execute.status).toBe(404);
    await expect(execute.json()).resolves.toMatchObject({ error: { code: 'GC_JOB_NOT_FOUND' } });
  });
});
