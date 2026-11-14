import type {
  DataDescribeTableOutput,
} from '../../../contracts/tools/data-describe-table.js';
import type {
  DataListTablesOutput,
} from '../../../contracts/tools/data-list-tables.js';
import type { DataQueryOutput } from '../../../contracts/tools/data-query.js';
import type { ExecutionContext } from '../../../application/ports/warehouse-connector.js';

export class MockConnector {
  constructor(private readonly sourceLabel: string) {}

  async executeQuery(
    _input: { sql: string; max_rows?: number; timeout_ms?: number },
    _ctx: ExecutionContext,
  ): Promise<DataQueryOutput> {
    return {
      columns: [{ name: 'source', type: 'TEXT' }, { name: 'one', type: 'NUMBER' }],
      rows: [{ source: this.sourceLabel, one: 1 }],
      row_count_returned: 1,
      truncated: false,
      warehouse_execution_id: `${this.sourceLabel}-mock-exec`,
      stats: { mocked: true },
    };
  }

  async listTables(
    _input: { database?: string; schema?: string; pattern?: string; limit?: number },
    _ctx: ExecutionContext,
  ): Promise<DataListTablesOutput> {
    return {
      tables: [{ database: 'db', schema: 'public', name: `${this.sourceLabel}_table`, type: 'TABLE' }],
      truncated: false,
    };
  }

  async describeTable(
    input: { database: string; schema: string; table: string },
    _ctx: ExecutionContext,
  ): Promise<DataDescribeTableOutput> {
    return {
      database: input.database,
      schema: input.schema,
      table: input.table,
      columns: [{ name: 'id', type: 'VARCHAR', nullable: false }],
    };
  }
}

