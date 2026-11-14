import { z } from 'zod';

import { DataSourceSchema } from './common.js';

export const DataListTablesInputSchema = z.object({
  data_source: DataSourceSchema,
  database: z.string().min(1).optional(),
  schema: z.string().min(1).optional(),
  pattern: z.string().min(1).optional(),
  limit: z.number().int().positive().max(10_000).optional(),
});

export const DataListTablesOutputSchema = z.object({
  tables: z.array(
    z.object({
      database: z.string().optional(),
      schema: z.string().optional(),
      name: z.string(),
      type: z.string().optional(),
    }),
  ),
  truncated: z.boolean(),
});

export type DataListTablesInput = z.infer<typeof DataListTablesInputSchema>;
export type DataListTablesOutput = z.infer<typeof DataListTablesOutputSchema>;

