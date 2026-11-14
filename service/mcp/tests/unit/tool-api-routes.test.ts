import { describe, expect, it } from 'vitest';

import { buildAppDependencies } from '../../src/app/dependencies.js';
import { buildApp } from '../../src/app/server.js';
import { loadEnv } from '../../src/infrastructure/config/env.js';

describe('Tool API routes', () => {
  it('GET /v1/tools lists canonical tools', async () => {
    const env = loadEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: ':memory:',
    });
    const deps = buildAppDependencies(env);
    await deps.ready();
    const { token } = await deps.apiKeys.create({ owner_label: 'Test User' });
    const app = buildApp(deps);

    const res = await app.request('/v1/tools', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tools: Array<{ name: string }> };
    expect(body.tools.map((t) => t.name)).toEqual([
      'data.query',
      'data.list_tables',
      'data.describe_table',
      'registry.list_agents',
      'registry.get_agent',
      'registry.list_skills',
      'registry.get_skill',
      'registry.get_artifact',
      'registry.get_provenance',
      'registry.verify_publication',
      'registry.get_attestations',
      'registry.search',
    ]);
  });

  it('POST /v1/tools/data.query:execute returns stubbed result envelope', async () => {
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
        'x-agent-client': 'test',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ data_source: 'snowflake', sql: 'select 1' }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['error']).toBeNull();
    expect(body['result']).toMatchObject({ row_count_returned: 1, truncated: false });
    expect(typeof body['audit_id']).toBe('string');
  });

  it('POST /v1/tools/registry.list_agents:execute returns an empty list when registry is not ingested', async () => {
    const env = loadEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: ':memory:',
    });
    const deps = buildAppDependencies(env);
    await deps.ready();
    const { token } = await deps.apiKeys.create({ owner_label: 'Test User' });
    const app = buildApp(deps);

    const res = await app.request('/v1/tools/registry.list_agents:execute', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-agent-client': 'test',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['error']).toBeNull();
    expect(body['result']).toMatchObject({ agents: [] });
  });

  it('POST /v1/tools/registry.get_agent:execute returns explicit not-found for missing agents', async () => {
    const env = loadEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: ':memory:',
    });
    const deps = buildAppDependencies(env);
    await deps.ready();
    const { token } = await deps.apiKeys.create({ owner_label: 'Test User' });
    const app = buildApp(deps);

    const res = await app.request('/v1/tools/registry.get_agent:execute', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-agent-client': 'test',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ agent_urn: 'urn:sg:agent:missing' }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['result']).toBeNull();
    expect(body['error']).toMatchObject({ code: 'REGISTRY_ENTITY_NOT_FOUND' });
  });

  it('denies non-readonly SQL (audited) before connector execution', async () => {
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
      body: JSON.stringify({ data_source: 'snowflake', sql: 'drop table t' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['result']).toBeNull();
    expect(body['error']).toMatchObject({ code: 'SQL_NOT_READ_ONLY' });
  });
});

