import type { WarehouseConnector } from '../../../application/ports/warehouse-connector.js';
import type {
  DataDescribeTableInput,
  DataDescribeTableOutput,
} from '../../../contracts/tools/data-describe-table.js';
import type {
  DataListTablesInput,
  DataListTablesOutput,
} from '../../../contracts/tools/data-list-tables.js';
import type {
  DataQueryInput,
  DataQueryOutput,
} from '../../../contracts/tools/data-query.js';

export class StubWarehouseConnector implements WarehouseConnector {
  async executeQuery(_input: DataQueryInput): Promise<DataQueryOutput> {
    return {
      columns: [{ name: 'one', type: 'NUMBER' }],
      rows: [{ one: 1 }],
      row_count_returned: 1,
      truncated: false,
      warehouse_execution_id: 'stub-query-1',
      stats: { stub: true },
    };
  }

  async listTables(
    _input: DataListTablesInput,
  ): Promise<DataListTablesOutput> {
    return {
      tables: [
        { database: 'db', schema: 'public', name: 'example_table', type: 'TABLE' },
      ],
      truncated: false,
    };
  }

  async describeTable(
    input: DataDescribeTableInput,
  ): Promise<DataDescribeTableOutput> {
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
}

