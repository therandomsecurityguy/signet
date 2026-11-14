import { describe, expect, it } from 'vitest';

import { buildAppDependencies } from '../../src/app/dependencies.js';
import { buildApp } from '../../src/app/server.js';
import { loadEnv } from '../../src/infrastructure/config/env.js';

describe('metrics endpoint', () => {
  it('GET /metrics exposes Prometheus metrics including http request counters', async () => {
    const env = loadEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: ':memory:',
    });
    const deps = buildAppDependencies(env);
    const app = buildApp(deps);

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
});
