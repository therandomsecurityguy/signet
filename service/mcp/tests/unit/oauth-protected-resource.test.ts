import { describe, expect, it } from 'vitest';

import { buildAppDependencies } from '../../src/app/dependencies.js';
import { buildApp } from '../../src/app/server.js';
import { loadEnv } from '../../src/infrastructure/config/env.js';

describe('oauth protected resource metadata', () => {
  it('serves metadata document', async () => {
    const env = loadEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: ':memory:',
      OKTA_ISSUER: 'https://example.okta.com/oauth2/default',
      OKTA_REQUIRED_SCOPES: 'data.query.read data.catalog.read',
    });
    const deps = buildAppDependencies(env);
    await deps.ready();
    const app = buildApp(deps);

    const res = await app.request('/.well-known/oauth-protected-resource');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['authorization_servers']).toEqual([env.OKTA_ISSUER]);
    expect(body['scopes_supported']).toEqual(['data.query.read', 'data.catalog.read']);
  });
});

