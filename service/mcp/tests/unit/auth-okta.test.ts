import { describe, expect, it } from 'vitest';

import { buildAppDependencies } from '../../src/app/dependencies.js';
import { buildApp } from '../../src/app/server.js';
import { loadEnv } from '../../src/infrastructure/config/env.js';

describe('okta auth (mock mode)', () => {
  it('allows requests with any bearer token when OKTA_MODE=mock', async () => {
    const env = loadEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: ':memory:',
      AUTH_MODE: 'okta',
      OKTA_MODE: 'mock',
    });

    const deps = buildAppDependencies(env);
    await deps.ready();
    const app = buildApp(deps);

    const res = await app.request('/v1/tools', {
      headers: { authorization: 'Bearer okta-mock-token' },
    });
    expect(res.status).toBe(200);
  });
});

