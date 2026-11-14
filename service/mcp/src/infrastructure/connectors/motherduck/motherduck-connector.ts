import type { Env } from '../../config/env.js';
import type { ExecutionContext } from '../../../application/ports/warehouse-connector.js';
import type { DataQueryOutput } from '../../../contracts/tools/data-query.js';
import type { DataListTablesOutput } from '../../../contracts/tools/data-list-tables.js';
import type { DataDescribeTableOutput } from '../../../contracts/tools/data-describe-table.js';
import { DomainError } from '../../../domain/errors/domain-error.js';
import { ErrorCode } from '../../../domain/errors/error-codes.js';

export class MotherDuckConnector {
  constructor(private readonly env: Env) {}

  async executeQuery(
    _input: { sql: string; max_rows?: number; timeout_ms?: number },
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

    // Real driver wiring is intentionally deferred until creds/environment exist.
    throw new DomainError({
      code: ErrorCode.InternalError,
      httpStatus: 501,
      safeMessage: 'MotherDuck real connector not enabled (mock mode recommended).',
    });
  }

  async listTables(
    _input: { database?: string; schema?: string; pattern?: string; limit?: number },
    _ctx: ExecutionContext,
  ): Promise<DataListTablesOutput> {
    if (this.env.MOTHERDUCK_MODE === 'mock') {
      return {
        tables: [{ database: 'md', schema: 'main', name: 'MOTHERDUCK_TABLE', type: 'TABLE' }],
        truncated: false,
      };
    }
    return { tables: [], truncated: false };
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
    return { database: input.database, schema: input.schema, table: input.table, columns: [] };
  }
}

