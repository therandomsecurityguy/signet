import { describe, expect, it } from 'vitest';

import { ListDataSourcesUseCase } from '../../src/application/usecases/list-data-sources.js';
import { buildAppDependencies } from '../../src/app/dependencies.js';
import { buildApp } from '../../src/app/server.js';
import { loadEnv } from '../../src/infrastructure/config/env.js';

function baseEnv(overrides: Record<string, string> = {}) {
  return loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: ':memory:',
    ...overrides,
  });
}

describe('data source readiness', () => {
  it('reports all three sources ready in mock mode (the default)', () => {
    const result = new ListDataSourcesUseCase(baseEnv()).execute();
    expect(result.data_sources).toEqual([
      { data_source: 'snowflake', mode: 'mock', ready: true },
      { data_source: 'athena', mode: 'mock', ready: true },
      { data_source: 'motherduck', mode: 'mock', ready: true },
    ]);
  });

  it('lists missing real-mode config by name (never values)', () => {
    const result = new ListDataSourcesUseCase(
      baseEnv({ SNOWFLAKE_MODE: 'real', ATHENA_MODE: 'real', MOTHERDUCK_MODE: 'real' }),
    ).execute();
    const bySource = Object.fromEntries(result.data_sources.map((row) => [row.data_source, row]));

    expect(bySource['snowflake']).toMatchObject({ mode: 'real', ready: false });
    expect(bySource['snowflake']?.missing_config).toEqual([
      'SNOWFLAKE_ACCOUNT',
      'SNOWFLAKE_USERNAME',
      'SNOWFLAKE_PASSWORD',
    ]);
    expect(bySource['athena']).toMatchObject({ mode: 'real', ready: false });
    expect(bySource['athena']?.missing_config).toEqual(['ATHENA_WORKGROUP', 'ATHENA_OUTPUT_S3']);
    expect(bySource['motherduck']).toMatchObject({ mode: 'real', ready: false });
    expect(bySource['motherduck']?.missing_config).toEqual(['MOTHERDUCK_TOKEN']);
  });

  it('marks MotherDuck real mode ready with a token and notes the database default', () => {
    const result = new ListDataSourcesUseCase(
      baseEnv({ MOTHERDUCK_MODE: 'real', MOTHERDUCK_TOKEN: 'md-token' }),
    ).execute();
    const motherduck = result.data_sources.find((row) => row.data_source === 'motherduck');
    expect(motherduck).toMatchObject({ mode: 'real', ready: true });
    expect(motherduck?.missing_config).toBeUndefined();
    expect(motherduck?.notes).toContain('MOTHERDUCK_DATABASE');
  });

  it('marks real mode ready when the required config is present', () => {
    const result = new ListDataSourcesUseCase(
      baseEnv({
        SNOWFLAKE_MODE: 'real',
        SNOWFLAKE_ACCOUNT: 'acct',
        SNOWFLAKE_USERNAME: 'user',
        SNOWFLAKE_PASSWORD: 'pass',
        ATHENA_MODE: 'real',
        ATHENA_WORKGROUP: 'wg',
        ATHENA_OUTPUT_S3: 's3://bucket/out',
      }),
    ).execute();
    const bySource = Object.fromEntries(result.data_sources.map((row) => [row.data_source, row]));

    expect(bySource['snowflake']).toMatchObject({ mode: 'real', ready: true });
    expect(bySource['snowflake']?.missing_config).toBeUndefined();
    expect(bySource['snowflake']?.notes).toContain('catalog metadata');
    expect(bySource['athena']).toMatchObject({ mode: 'real', ready: true });
    expect(bySource['athena']?.missing_config).toBeUndefined();
  });

  it('serves GET /v1/data-sources behind bearer auth', async () => {
    const env = baseEnv();
    const deps = buildAppDependencies(env);
    await deps.ready();
    const app = buildApp(deps);

    const unauthenticated = await app.request('/v1/data-sources');
    expect(unauthenticated.status).toBe(401);

    const { token } = await deps.apiKeys.create({ owner_label: 'Readiness Reader' });
    const res = await app.request('/v1/data-sources', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data_sources: Array<{ data_source: string; mode: string; ready: boolean }> };
    expect(body.data_sources.map((row) => row.data_source)).toEqual(['snowflake', 'athena', 'motherduck']);
    expect(body.data_sources.every((row) => row.mode === 'mock' && row.ready)).toBe(true);
  });
});
