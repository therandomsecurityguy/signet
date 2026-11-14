import { describe, expect, it } from 'vitest';

import { buildAppDependencies } from '../../src/app/dependencies.js';
import { buildApp } from '../../src/app/server.js';
import { loadEnv } from '../../src/infrastructure/config/env.js';

describe('auth + audit (sqlite)', () => {
  it('missing bearer returns 401 and is audited', async () => {
    const env = loadEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: ':memory:',
    });
    const deps = buildAppDependencies(env);
    await deps.ready();
    const app = buildApp(deps);

    const res = await app.request('/v1/tools');
    expect(res.status).toBe(401);

    const db = await deps.db.getDb();
    const row = await db.get<{ c: number }>(
      `SELECT COUNT(*) as c FROM audit_events WHERE event_type = 'auth'`,
    );
    expect(row?.c ?? 0).toBe(1);
  });

  it('valid bearer allows execution and tool call is audited', async () => {
    const env = loadEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: ':memory:',
    });
    const deps = buildAppDependencies(env);
    await deps.ready();
    const { token } = await deps.apiKeys.create({ owner_label: 'Test User' });
    const app = buildApp(deps);

    const res = await app.request('/v1/tools/data.query:execute', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        'x-agent-client': 'test',
      },
      body: JSON.stringify({ data_source: 'snowflake', sql: 'select 1' }),
    });
    expect(res.status).toBe(200);

    const db = await deps.db.getDb();
    const row = await db.get<{ c: number }>(
      `SELECT COUNT(*) as c FROM audit_events WHERE event_type = 'tool'`,
    );
    expect(row?.c ?? 0).toBe(1);
  });
});

