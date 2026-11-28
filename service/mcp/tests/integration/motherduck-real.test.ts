import { afterEach, describe, expect, it } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';

import {
  MotherDuckConnector,
  type DuckDBInstanceFactory,
} from '../../src/infrastructure/connectors/motherduck/motherduck-connector.js';
import { loadEnv } from '../../src/infrastructure/config/env.js';
import { DomainError } from '../../src/domain/errors/domain-error.js';

// Exercises the MotherDuck real path against a REAL local DuckDB engine: the
// connector is built with an instance factory backed by a shared `:memory:`
// instance instead of the `md:` connection string, so the SQL, row mapping,
// and timeout paths run without MotherDuck credentials. (The `md:` attach
// itself needs a token and network; it is identical driver code beyond the
// connection target.)
const ctx = { request_id: 'test', client_name: 'test' };

const instances: DuckDBInstance[] = [];

afterEach(() => {
  for (const instance of instances.splice(0)) {
    instance.closeSync();
  }
});

async function localRig() {
  const instance = await DuckDBInstance.create(':memory:');
  instances.push(instance);
  const factory: DuckDBInstanceFactory = async () => instance;
  return {
    connector: (overrides: Record<string, string> = {}) =>
      new MotherDuckConnector(
        loadEnv({
          NODE_ENV: 'test',
          LOG_LEVEL: 'silent',
          DATABASE_URL: ':memory:',
          MOTHERDUCK_MODE: 'real',
          MOTHERDUCK_TOKEN: 'test-token',
          ...overrides,
        }),
        factory,
      ),
    run: async (sql: string) => {
      const connection = await instance.connect();
      try {
        await connection.run(sql);
      } finally {
        connection.closeSync();
      }
    },
  };
}

describe('MotherDuck connector (real path on a local DuckDB engine)', () => {
  it('maps query rows and column types with JSON-safe values', async () => {
    const rig = await localRig();
    const result = await rig.connector().executeQuery(
      {
        sql: `select 1 as one, 'x' as s, 9223372036854775807::BIGINT as big, DATE '2026-01-02' as d`,
      },
      ctx,
    );

    expect(result.columns).toEqual([
      { name: 'one', type: 'INTEGER' },
      { name: 's', type: 'VARCHAR' },
      { name: 'big', type: 'BIGINT' },
      { name: 'd', type: 'DATE' },
    ]);
    expect(result.row_count_returned).toBe(1);
    expect(result.truncated).toBe(false);
    // JSON form keeps 64-bit integers and dates lossless (never JS numbers).
    expect(result.rows[0]).toEqual({
      one: 1,
      s: 'x',
      big: '9223372036854775807',
      d: '2026-01-02',
    });
  });

  it('lists tables through information_schema, honoring filters and limit', async () => {
    const rig = await localRig();
    await rig.run('create table golden_duck(id integer, name varchar)');

    const all = await rig.connector().listTables({}, ctx);
    const golden = all.tables.find((table) => table.name === 'golden_duck');
    expect(golden).toMatchObject({ name: 'golden_duck', schema: 'main', type: 'BASE TABLE' });
    expect(golden?.database).toBeTruthy();

    const filtered = await rig.connector().listTables({ pattern: 'golden%' }, ctx);
    expect(filtered.tables.length).toBeGreaterThan(0);
    expect(filtered.tables.every((table) => table.name.startsWith('golden'))).toBe(true);

    const limited = await rig.connector().listTables({ limit: 1 }, ctx);
    expect(limited.tables).toHaveLength(1);
    expect(limited.truncated).toBe(true);
  });

  it('describes a table with nullable flags', async () => {
    const rig = await localRig();
    await rig.run('create table described_duck(id integer, name varchar)');

    const described = await rig
      .connector()
      .describeTable({ database: 'memory', schema: 'main', table: 'described_duck' }, ctx);
    expect(described).toMatchObject({ database: 'memory', schema: 'main', table: 'described_duck' });
    expect(described.columns).toEqual([
      { name: 'id', type: 'INTEGER', nullable: true },
      { name: 'name', type: 'VARCHAR', nullable: true },
    ]);
  });

  it('rejects unsafe identifiers before interpolation', async () => {
    const rig = await localRig();
    await expect(
      rig.connector().describeTable({ database: 'bad"name', schema: 'main', table: 't' }, ctx),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', httpStatus: 400 });
  });

  it('fails closed without a token', async () => {
    const rig = await localRig();
    await expect(
      rig.connector({ MOTHERDUCK_TOKEN: '' }).executeQuery({ sql: 'select 1' }, ctx),
    ).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      safeMessage: 'MotherDuck is not configured.',
    });
  });

  it('keeps the interrupt error from masking the timeout DomainError', async () => {
    const rig = await localRig();
    const error = await rig
      .connector()
      .executeQuery(
        { sql: 'select count(*) from range(100000000000) t(a), range(100) u(b)', timeout_ms: 1 },
        ctx,
      )
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe('CONNECTOR_TIMEOUT');
  });
});
