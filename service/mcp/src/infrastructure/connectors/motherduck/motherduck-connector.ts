import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBConnection, DuckDBValue } from '@duckdb/node-api';

import type { Env } from '../../config/env.js';
import type { ExecutionContext } from '../../../application/ports/warehouse-connector.js';
import type { DataQueryOutput } from '../../../contracts/tools/data-query.js';
import type { DataListTablesOutput } from '../../../contracts/tools/data-list-tables.js';
import type { DataDescribeTableOutput } from '../../../contracts/tools/data-describe-table.js';
import { DomainError } from '../../../domain/errors/domain-error.js';
import { ErrorCode } from '../../../domain/errors/error-codes.js';

// Test seam: production creates MotherDuck instances through DuckDB's shared
// instance cache (MotherDuck's Node client does not cache automatically);
// tests inject a factory backed by a real local DuckDB (`:memory:`) so the
// SQL paths below execute on the actual engine without MotherDuck
// credentials. Only the connection target differs.
export type DuckDBInstanceFactory = (
  path: string,
  options: Record<string, string>,
) => Promise<Pick<DuckDBInstance, 'connect'>>;

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const LIST_TABLES_DEFAULT_LIMIT = 1000;
const LIST_TABLES_MAX_LIMIT = 10_000;
const DEFAULT_DATABASE = 'my_db';
// Bound the whole connect sequence (token exchange, welcome pack, first
// database attach) so a slow MotherDuck startup cannot hold a request open
// indefinitely (MotherDuck documents this as `connection_timeout`).
const CONNECTION_TIMEOUT = '30s';

export class MotherDuckConnector {
  private readonly createInstance: DuckDBInstanceFactory;

  constructor(
    private readonly env: Env,
    createInstance?: DuckDBInstanceFactory,
  ) {
    this.createInstance =
      createInstance ?? ((path, options) => DuckDBInstance.fromCache(path, options));
  }

  async executeQuery(
    input: { sql: string; max_rows?: number; timeout_ms?: number },
    _ctx: ExecutionContext,
  ): Promise<DataQueryOutput> {
    if (this.env.MOTHERDUCK_MODE === 'mock') {
      return {
        columns: [{ name: 'one', type: 'NUMBER' }],
        rows: [{ one: 1 }],
        row_count_returned: 1,
        truncated: false,
        warehouse_execution_id: 'motherduck-mock-exec',
        stats: { mocked: true },
      };
    }

    this.assertConfigured();
    const timeoutMs = Math.min(
      Math.max(input.timeout_ms ?? this.env.TOOL_TIMEOUT_MS_DEFAULT, 1),
      this.env.TOOL_TIMEOUT_MS_HARD_MAX,
    );

    return await this.withConnection(async (connection) => {
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        // Cancel the running statement; the awaited run rejects below.
        try {
          connection.interrupt();
        } catch {
          // The query already finished between the timer firing and this call.
        }
      }, timeoutMs);
      try {
        const reader = await connection.runAndReadAll(input.sql);
        // JSON-safe conversion: 64-bit integers, temporal, decimal, and blob
        // values survive transportation without lossy JS rewrites.
        const rows = reader.getRowObjectsJson() as Record<string, unknown>[];
        const columnNames = reader.columnNames();
        const columnTypes = reader.columnTypes();
        return {
          columns: columnNames.map((name, index) => ({ name, type: String(columnTypes[index]) })),
          rows,
          row_count_returned: rows.length,
          truncated: false,
        };
      } catch (err) {
        if (timedOut) {
          throw new DomainError({
            code: ErrorCode.ConnectorTimeout,
            httpStatus: 504,
            safeMessage: 'MotherDuck query timed out.',
          });
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    });
  }

  async listTables(
    input: { database?: string; schema?: string; pattern?: string; limit?: number },
    _ctx: ExecutionContext,
  ): Promise<DataListTablesOutput> {
    if (this.env.MOTHERDUCK_MODE === 'mock') {
      return {
        tables: [{ database: 'md', schema: 'main', name: 'MOTHERDUCK_TABLE', type: 'TABLE' }],
        truncated: false,
      };
    }

    this.assertConfigured();
    const clauses: string[] = [];
    const values: DuckDBValue[] = [];
    if (input.database) {
      clauses.push('table_catalog = ?');
      values.push(input.database);
    }
    if (input.schema) {
      clauses.push('table_schema = ?');
      values.push(input.schema);
    }
    if (input.pattern) {
      clauses.push('table_name LIKE ?');
      values.push(input.pattern);
    }
    const limit = Math.min(
      Math.max(input.limit ?? LIST_TABLES_DEFAULT_LIMIT, 1),
      LIST_TABLES_MAX_LIMIT,
    );
    const sql = [
      'SELECT table_catalog AS "database", table_schema AS "schema", table_name AS "name", table_type AS "type"',
      'FROM information_schema.tables',
      clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
      'ORDER BY table_catalog, table_schema, table_name',
      'LIMIT ?',
    ]
      .filter((line) => line.length > 0)
      .join('\n');

    return await this.withConnection(async (connection) => {
      const reader = await connection.runAndReadAll(sql, [...values, limit]);
      const rows = reader.getRowObjectsJson() as Array<Record<string, unknown>>;
      return {
        tables: rows.map((row) => ({
          ...(row['database'] !== null ? { database: String(row['database']) } : {}),
          ...(row['schema'] !== null ? { schema: String(row['schema']) } : {}),
          name: String(row['name']),
          ...(row['type'] !== null ? { type: String(row['type']) } : {}),
        })),
        truncated: rows.length >= limit,
      };
    });
  }

  async describeTable(
    input: { database: string; schema: string; table: string },
    _ctx: ExecutionContext,
  ): Promise<DataDescribeTableOutput> {
    if (this.env.MOTHERDUCK_MODE === 'mock') {
      return {
        database: input.database,
        schema: input.schema,
        table: input.table,
        columns: [{ name: 'id', type: 'varchar', nullable: false }],
      };
    }

    this.assertConfigured();
    for (const [label, value] of [
      ['database', input.database],
      ['schema', input.schema],
      ['table', input.table],
    ] as const) {
      if (!IDENTIFIER_PATTERN.test(value)) {
        throw new DomainError({
          code: ErrorCode.ValidationError,
          httpStatus: 400,
          safeMessage: `Invalid ${label} identifier for MotherDuck describe_table.`,
        });
      }
    }
    // Identifiers are validated above; DESCRIBE cannot bind them as values.
    const qualified = `"${input.database}"."${input.schema}"."${input.table}"`;

    const columns = await this.withConnection(async (connection) => {
      const reader = await connection.runAndReadAll(`DESCRIBE SELECT * FROM ${qualified}`);
      return reader.getRowObjects() as Array<Record<string, unknown>>;
    });

    return {
      database: input.database,
      schema: input.schema,
      table: input.table,
      columns: columns.map((row) => ({
        name: String(row['column_name']),
        type: String(row['column_type']),
        nullable: String(row['null']).toUpperCase() === 'YES',
      })),
    };
  }

  private connectionPath(): string {
    const database =
      this.env.MOTHERDUCK_DATABASE && this.env.MOTHERDUCK_DATABASE.trim().length > 0
        ? this.env.MOTHERDUCK_DATABASE.trim()
        : DEFAULT_DATABASE;
    return `md:${database}?connection_timeout=${CONNECTION_TIMEOUT}`;
  }

  private connectionOptions(): Record<string, string> {
    return { motherduck_token: this.env.MOTHERDUCK_TOKEN ?? '' };
  }

  private assertConfigured() {
    if (!this.env.MOTHERDUCK_TOKEN || this.env.MOTHERDUCK_TOKEN.trim().length === 0) {
      throw new DomainError({
        code: ErrorCode.InternalError,
        httpStatus: 500,
        safeMessage: 'MotherDuck is not configured.',
      });
    }
  }

  private async withConnection<T>(run: (connection: DuckDBConnection) => Promise<T>): Promise<T> {
    let connection: DuckDBConnection | undefined;
    try {
      const instance = await this.createInstance(this.connectionPath(), this.connectionOptions());
      connection = await instance.connect();
      return await run(connection);
    } catch (err) {
      if (err instanceof DomainError) {
        throw err;
      }
      throw new DomainError({
        code: ErrorCode.InternalError,
        httpStatus: 502,
        safeMessage: 'MotherDuck request failed.',
      });
    } finally {
      try {
        connection?.closeSync();
      } catch {
        // Best-effort close; the instance cache owns the database lifetime.
      }
    }
  }
}
