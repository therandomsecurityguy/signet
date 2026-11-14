import snowflake from 'snowflake-sdk';

import type { Env } from '../../config/env.js';
import type {
  DataDescribeTableOutput,
} from '../../../contracts/tools/data-describe-table.js';
import type {
  DataListTablesOutput,
} from '../../../contracts/tools/data-list-tables.js';
import type { DataQueryOutput } from '../../../contracts/tools/data-query.js';
import type { ExecutionContext } from '../../../application/ports/warehouse-connector.js';
import { DomainError } from '../../../domain/errors/domain-error.js';
import { ErrorCode } from '../../../domain/errors/error-codes.js';

export class SnowflakeConnector {
  constructor(private readonly env: Env) {}

  async executeQuery(
    input: { sql: string; max_rows?: number; timeout_ms?: number },
    _ctx: ExecutionContext,
  ): Promise<DataQueryOutput> {
    if (this.env.SNOWFLAKE_MODE === 'mock') {
      return {
        columns: [{ name: 'one', type: 'NUMBER' }],
        rows: [{ one: 1 }],
        row_count_returned: 1,
        truncated: false,
        warehouse_execution_id: 'snowflake-mock-query-id',
        stats: { mocked: true },
      };
    }

    const connection = this.createConnection();
    await new Promise<void>((resolve, reject) => {
      connection.connect((err) => (err ? reject(err) : resolve()));
    });

    try {
      const { rows, queryId } = await new Promise<{ rows: Record<string, unknown>[]; queryId?: string }>(
        (resolve, reject) => {
          connection.execute({
            sqlText: input.sql,
            complete(err, stmt, rows) {
              if (err) return reject(err);
              resolve({
                rows: (rows ?? []) as Record<string, unknown>[],
                queryId: stmt?.getQueryId?.(),
              });
            },
          });
        },
      );

      const columns =
        rows.length > 0
          ? Object.keys(rows[0] ?? {}).map((name) => ({ name }))
          : [];

      return {
        columns,
        rows,
        row_count_returned: rows.length,
        truncated: false,
        warehouse_execution_id: queryId,
      };
    } catch {
      throw new DomainError({
        code: ErrorCode.InternalError,
        httpStatus: 502,
        safeMessage: 'Snowflake query failed.',
      });
    } finally {
      connection.destroy((_) => undefined);
    }
  }

  async listTables(
    _input: { database?: string; schema?: string; pattern?: string; limit?: number },
    _ctx: ExecutionContext,
  ): Promise<DataListTablesOutput> {
    if (this.env.SNOWFLAKE_MODE === 'mock') {
      return {
        tables: [{ database: 'DB', schema: 'PUBLIC', name: 'EXAMPLE_TABLE', type: 'TABLE' }],
        truncated: false,
      };
    }

    // Minimal v1: keep as a stub until Phase 6 hardening (metadata parity).
    return {
      tables: [],
      truncated: false,
    };
  }

  async describeTable(
    input: { database: string; schema: string; table: string },
    _ctx: ExecutionContext,
  ): Promise<DataDescribeTableOutput> {
    if (this.env.SNOWFLAKE_MODE === 'mock') {
      return {
        database: input.database,
        schema: input.schema,
        table: input.table,
        columns: [
          { name: 'id', type: 'VARCHAR', nullable: false },
          { name: 'created_at', type: 'TIMESTAMP', nullable: true },
        ],
      };
    }

    return {
      database: input.database,
      schema: input.schema,
      table: input.table,
      columns: [],
    };
  }

  private createConnection() {
    if (
      !this.env.SNOWFLAKE_ACCOUNT ||
      !this.env.SNOWFLAKE_USERNAME ||
      !this.env.SNOWFLAKE_PASSWORD
    ) {
      throw new DomainError({
        code: ErrorCode.InternalError,
        httpStatus: 500,
        safeMessage: 'Snowflake is not configured.',
      });
    }

    const options: snowflake.ConnectionOptions = {
      account: this.env.SNOWFLAKE_ACCOUNT,
      username: this.env.SNOWFLAKE_USERNAME,
      password: this.env.SNOWFLAKE_PASSWORD,
    };

    if (this.env.SNOWFLAKE_WAREHOUSE) options.warehouse = this.env.SNOWFLAKE_WAREHOUSE;
    if (this.env.SNOWFLAKE_DATABASE) options.database = this.env.SNOWFLAKE_DATABASE;
    if (this.env.SNOWFLAKE_SCHEMA) options.schema = this.env.SNOWFLAKE_SCHEMA;
    if (this.env.SNOWFLAKE_ROLE) options.role = this.env.SNOWFLAKE_ROLE;

    return snowflake.createConnection(options);
  }
}

