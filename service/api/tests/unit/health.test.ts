import { describe, expect, it } from 'vitest';

import { loadEnv } from '../../src/infrastructure/config/env.js';
import { buildAppDependencies } from '../../src/app/dependencies.js';
import { buildApp } from '../../src/app/server.js';

describe('health endpoints', () => {
  function buildTestApp() {
    const env = loadEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      REGISTRY_GRAPH_BACKEND: 'memory',
    });
    const deps = buildAppDependencies(env);
    return buildApp(deps);
  }

  it('GET /healthz returns ok', async () => {
    const app = buildTestApp();
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it('GET /readyz returns ok', async () => {
    const app = buildTestApp();
    const res = await app.request('/readyz');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it('GET /v1 describes current service boundaries', async () => {
    const app = buildTestApp();
    const res = await app.request('/v1');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      service: 'agent-registry-api',
      status: 'agents-and-skills-metadata-slice',
      depends_on: ['service/registry'],
      auth: {
        mode: 'api_key',
        okta_mode: 'mock',
      },
    });
  });
});
