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
  return { app: buildApp(deps) };
}

describe('OpenAPI contract', () => {
  it('serves a valid OpenAPI 3.1 document at /v1/openapi.json', async () => {
    const { app } = await buildTestApp();
    const res = await app.request('/v1/openapi.json');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');

    const spec = (await res.json()) as {
      openapi: string;
      info: { title: string; version: string };
      paths: Record<string, unknown>;
    };
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.info.title).toBe('Signet Registry API');
    expect(spec.info.version).toBe('1.0.0');
    expect(Object.keys(spec.paths).length).toBeGreaterThan(0);
  });

  it('documents the core registry read and lifecycle paths', async () => {
    const { app } = await buildTestApp();
    const res = await app.request('/v1/openapi.json');
    const spec = (await res.json()) as { paths: Record<string, unknown> };

    for (const path of [
      '/v1/agents',
      '/v1/agents/{agentKey}',
      '/v1/skills',
      '/v1/skills/{skillKey}',
      '/v1/skills/{skillKey}/versions/{version}/publish',
      '/v1/skills/{skillKey}/versions/{version}/certify',
      '/v1/public-keys',
      '/v1/transparency-logs',
      '/v1/time-aware/commits',
      '/v1/graph/subgraph',
    ]) {
      expect(spec.paths[path], `expected path ${path} to be documented`).toBeDefined();
    }
  });

  it('serves the Swagger UI at /v1/docs', async () => {
    const { app } = await buildTestApp();
    const res = await app.request('/v1/docs');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });
});
