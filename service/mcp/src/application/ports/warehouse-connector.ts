import type { DataDescribeTableInput, DataDescribeTableOutput } from '../../contracts/tools/data-describe-table.js';
import type { DataListTablesInput, DataListTablesOutput } from '../../contracts/tools/data-list-tables.js';
import type { DataQueryInput, DataQueryOutput } from '../../contracts/tools/data-query.js';

export type ExecutionContext = {
  request_id: string;
  client_name: string;
};

export interface WarehouseConnector {
  executeQuery(input: DataQueryInput, ctx: ExecutionContext): Promise<DataQueryOutput>;
  listTables(
    input: DataListTablesInput,
    ctx: ExecutionContext,
  ): Promise<DataListTablesOutput>;
  describeTable(
    input: DataDescribeTableInput,
    ctx: ExecutionContext,
  ): Promise<DataDescribeTableOutput>;
}

