import { describe, expect, it } from 'vitest';

import { buildAppDependencies } from '../../src/app/dependencies.js';
import { buildApp } from '../../src/app/server.js';
import { loadEnv } from '../../src/infrastructure/config/env.js';

// Roadmap worksession 39: the data-access golden path. Every approved source
// must serve data.list_tables -> data.describe_table -> data.query through
// the real tool execution path (auth + policy + audit) with deterministic
// mock data, so an operator or agent can follow the same path against any
// source without warehouse credentials.
const SOURCES = [
  { data_source: 'snowflake', table: 'EXAMPLE_TABLE', execId: 'snowflake-mock-query-id' },
  { data_source: 'athena', table: 'ATHENA_TABLE', execId: 'athena-mock-exec' },
  { data_source: 'motherduck', table: 'MOTHERDUCK_TABLE', execId: 'motherduck-mock-exec' },
] as const;

describe('data-access golden path (mock sources)', () => {
  it('serves list_tables, describe_table, and query for every approved source', async () => {
    const env = loadEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: ':memory:',
    });
    const deps = buildAppDependencies(env);
    await deps.ready();
    const { token } = await deps.apiKeys.create({ owner_label: 'Golden Path' });
    const app = buildApp(deps);

    const call = async (tool: string, body: Record<string, unknown>) => {
      const res = await app.request(`/v1/tools/${tool}:execute`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-agent-client': 'golden-path',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(200);
      const parsed = (await res.json()) as { error: unknown; result: Record<string, unknown>; audit_id?: string };
      expect(parsed.error).toBeNull();
      expect(typeof parsed.audit_id).toBe('string');
      return parsed.result;
    };

    for (const source of SOURCES) {
      const tables = await call('data.list_tables', { data_source: source.data_source });
      const tableRows = tables['tables'] as Array<{ name: string; type?: string }>;
      expect(tableRows[0]?.name).toBe(source.table);
      expect(tables['truncated']).toBe(false);

      const described = await call('data.describe_table', {
        data_source: source.data_source,
        database: 'demo_db',
        schema: 'demo_schema',
        table: source.table,
      });
      expect(described).toMatchObject({ database: 'demo_db', schema: 'demo_schema', table: source.table });
      const columnRows = described['columns'] as Array<{ name: string }>;
      expect(columnRows[0]?.name).toBe('id');

      const queried = await call('data.query', { data_source: source.data_source, sql: 'select 1 as one' });
      expect(queried).toMatchObject({
        row_count_returned: 1,
        truncated: false,
        warehouse_execution_id: source.execId,
      });
      expect((queried['rows'] as Array<{ one: number }>)[0]?.one).toBe(1);
    }

    // Every one of the nine calls is audited as a tool event.
    const db = await deps.db.getDb();
    const row = await db.get<{ c: number }>(
      `SELECT COUNT(*) as c FROM audit_events WHERE event_type = 'tool'`,
    );
    expect(row?.c ?? 0).toBe(SOURCES.length * 3);
  });

  it('reports every source ready before the first query', async () => {
    const env = loadEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: ':memory:',
    });
    const deps = buildAppDependencies(env);
    await deps.ready();
    const { token } = await deps.apiKeys.create({ owner_label: 'Golden Path' });
    const app = buildApp(deps);

    const res = await app.request('/v1/data-sources', {
      headers: { authorization: `Bearer ${token}`, 'x-agent-client': 'golden-path' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data_sources: Array<{ data_source: string; mode: string; ready: boolean }> };
    expect(body.data_sources).toEqual([
      { data_source: 'snowflake', mode: 'mock', ready: true },
      { data_source: 'athena', mode: 'mock', ready: true },
      { data_source: 'motherduck', mode: 'mock', ready: true },
    ]);
  });
});
