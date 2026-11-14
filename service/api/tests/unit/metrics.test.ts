import { describe, expect, it } from 'vitest';

import { loadEnv } from '../../src/infrastructure/config/env.js';
import { buildAppDependencies } from '../../src/app/dependencies.js';
import { buildApp } from '../../src/app/server.js';

describe('metrics endpoint', () => {
  function buildTestApp(overrides: NodeJS.ProcessEnv = {}) {
    const env = loadEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      REGISTRY_GRAPH_BACKEND: 'memory',
      ...overrides,
    });
    const deps = buildAppDependencies(env);
    return buildApp(deps);
  }

  it('GET /metrics exposes Prometheus metrics including http request counters', async () => {
    const app = buildTestApp();
    // Generate a request so the http_requests_total series exists.
    await app.request('/healthz');

    const res = await app.request('/metrics');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');

    const body = await res.text();
    expect(body).toContain('http_requests_total');
    expect(body).toContain('http_request_duration_seconds');
    expect(body).toContain('route="/healthz"');
  });

  it('requires the configured bearer token when METRICS_AUTH_TOKEN is set', async () => {
    const app = buildTestApp({ METRICS_AUTH_TOKEN: 'metrics-secret' });

    const denied = await app.request('/metrics');
    expect(denied.status).toBe(401);

    const wrong = await app.request('/metrics', { headers: { authorization: 'Bearer nope' } });
    expect(wrong.status).toBe(401);

    const allowed = await app.request('/metrics', {
      headers: { authorization: 'Bearer metrics-secret' },
    });
    expect(allowed.status).toBe(200);
  });
});
