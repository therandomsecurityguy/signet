import { z } from 'zod';

import { DataSourceSchema } from './common.js';

export const DataQueryInputSchema = z.object({
  data_source: DataSourceSchema,
  sql: z.string().min(1).max(50_000),
  max_rows: z.number().int().positive().max(500).optional(),
  timeout_ms: z.number().int().positive().max(60_000).optional(),
});

export const DataQueryOutputSchema = z.object({
  columns: z.array(
    z.object({
      name: z.string(),
      type: z.string().optional(),
    }),
  ),
  rows: z.array(z.record(z.string(), z.unknown())),
  row_count_returned: z.number().int().nonnegative(),
  truncated: z.boolean(),
  warehouse_execution_id: z.string().optional(),
  stats: z.record(z.string(), z.unknown()).optional(),
});

export type DataQueryInput = z.infer<typeof DataQueryInputSchema>;
export type DataQueryOutput = z.infer<typeof DataQueryOutputSchema>;

