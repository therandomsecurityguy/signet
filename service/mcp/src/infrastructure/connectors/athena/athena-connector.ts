import {
  AthenaClient,
  type AthenaClientConfig,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  StartQueryExecutionCommand,
  StopQueryExecutionCommand,
} from '@aws-sdk/client-athena';

import type { Env } from '../../config/env.js';
import type { ExecutionContext } from '../../../application/ports/warehouse-connector.js';
import type { DataQueryOutput } from '../../../contracts/tools/data-query.js';
import type { DataListTablesOutput } from '../../../contracts/tools/data-list-tables.js';
import type { DataDescribeTableOutput } from '../../../contracts/tools/data-describe-table.js';
import { DomainError } from '../../../domain/errors/domain-error.js';
import { ErrorCode } from '../../../domain/errors/error-codes.js';

export class AthenaConnector {
  private readonly client: AthenaClient;

  constructor(private readonly env: Env) {
    const cfg: AthenaClientConfig = {};
    if (env.AWS_REGION) cfg.region = env.AWS_REGION;
    this.client = new AthenaClient(cfg);
  }

  async executeQuery(
    input: { sql: string; max_rows?: number; timeout_ms?: number },
    _ctx: ExecutionContext,
  ): Promise<DataQueryOutput> {
    if (this.env.ATHENA_MODE === 'mock') {
      return {
        columns: [{ name: 'one', type: 'NUMBER' }],
        rows: [{ one: 1 }],
        row_count_returned: 1,
        truncated: false,
        warehouse_execution_id: 'athena-mock-exec',
        stats: { mocked: true },
      };
    }

    const timeoutMs = input.timeout_ms ?? this.env.TOOL_TIMEOUT_MS_DEFAULT;

    const started = await this.client.send(
      new StartQueryExecutionCommand({
        QueryString: input.sql,
        WorkGroup: this.env.ATHENA_WORKGROUP,
        ResultConfiguration: {
          OutputLocation: this.env.ATHENA_OUTPUT_S3,
        },
      }),
    );

    const queryExecutionId = started.QueryExecutionId;
    if (!queryExecutionId) {
      throw new DomainError({
        code: ErrorCode.InternalError,
        httpStatus: 502,
        safeMessage: 'Athena query did not return an execution id.',
      });
    }

    const startedAt = Date.now();
    while (true) {
      const status = await this.client.send(
        new GetQueryExecutionCommand({ QueryExecutionId: queryExecutionId }),
      );
      const state = status.QueryExecution?.Status?.State;
      if (state === 'SUCCEEDED') break;
      if (state === 'FAILED' || state === 'CANCELLED') {
        throw new DomainError({
          code: ErrorCode.InternalError,
          httpStatus: 502,
          safeMessage: `Athena query ${state?.toLowerCase() ?? 'failed'}.`,
        });
      }

      if (Date.now() - startedAt > timeoutMs) {
        await this.client.send(
          new StopQueryExecutionCommand({ QueryExecutionId: queryExecutionId }),
        );
        throw new DomainError({
          code: ErrorCode.ConnectorTimeout,
          httpStatus: 504,
          safeMessage: 'The request timed out.',
        });
      }

      await sleep(750);
    }

    const results = await this.client.send(
      new GetQueryResultsCommand({ QueryExecutionId: queryExecutionId }),
    );

    // Minimal v1 parsing: return raw rows as objects where possible.
    const rows = results.ResultSet?.Rows ?? [];
    const header = rows[0]?.Data?.map((d) => d.VarCharValue ?? '') ?? [];
    const dataRows = rows.slice(1);
    const outRows: Record<string, unknown>[] = dataRows.map((r) => {
      const cells = r.Data ?? [];
      const obj: Record<string, unknown> = {};
      header.forEach((h, i) => {
        obj[h || `col_${i}`] = cells[i]?.VarCharValue ?? null;
      });
      return obj;
    });

    return {
      columns: header.map((name) => ({ name })),
      rows: outRows,
      row_count_returned: outRows.length,
      truncated: false,
      warehouse_execution_id: queryExecutionId,
    };
  }

  async listTables(
    _input: { database?: string; schema?: string; pattern?: string; limit?: number },
    _ctx: ExecutionContext,
  ): Promise<DataListTablesOutput> {
    if (this.env.ATHENA_MODE === 'mock') {
      return {
        tables: [{ database: 'db', schema: 'default', name: 'ATHENA_TABLE', type: 'TABLE' }],
        truncated: false,
      };
    }

    return { tables: [], truncated: false };
  }

  async describeTable(
    input: { database: string; schema: string; table: string },
    _ctx: ExecutionContext,
  ): Promise<DataDescribeTableOutput> {
    if (this.env.ATHENA_MODE === 'mock') {
      return {
        database: input.database,
        schema: input.schema,
        table: input.table,
        columns: [{ name: 'id', type: 'varchar', nullable: true }],
      };
    }

    return {
      database: input.database,
      schema: input.schema,
      table: input.table,
      columns: [],
    };
  }
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

