import type { WarehouseConnector } from '../../../application/ports/warehouse-connector.js';
import type { DataSource } from '../../../contracts/tools/common.js';
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
import type { ExecutionContext } from '../../../application/ports/warehouse-connector.js';

export type PerSourceConnector = {
  executeQuery(input: Omit<DataQueryInput, 'data_source'>, ctx: ExecutionContext): Promise<DataQueryOutput>;
  listTables(
    input: Omit<DataListTablesInput, 'data_source'>,
    ctx: ExecutionContext,
  ): Promise<DataListTablesOutput>;
  describeTable(
    input: Omit<DataDescribeTableInput, 'data_source'>,
    ctx: ExecutionContext,
  ): Promise<DataDescribeTableOutput>;
};

export class WarehouseRouterConnector implements WarehouseConnector {
  constructor(private readonly connectors: Record<DataSource, PerSourceConnector>) {}

  async executeQuery(input: DataQueryInput, ctx: ExecutionContext): Promise<DataQueryOutput> {
    const { data_source, ...rest } = input;
    return await this.connectors[data_source].executeQuery(rest, ctx);
  }

  async listTables(input: DataListTablesInput, ctx: ExecutionContext): Promise<DataListTablesOutput> {
    const { data_source, ...rest } = input;
    return await this.connectors[data_source].listTables(rest, ctx);
  }

  async describeTable(
    input: DataDescribeTableInput,
    ctx: ExecutionContext,
  ): Promise<DataDescribeTableOutput> {
    const { data_source, ...rest } = input;
    return await this.connectors[data_source].describeTable(rest, ctx);
  }
}

