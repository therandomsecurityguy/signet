import { z } from 'zod';

import { DataSourceSchema } from './common.js';

export const DataDescribeTableInputSchema = z.object({
  data_source: DataSourceSchema,
  database: z.string().min(1),
  schema: z.string().min(1),
  table: z.string().min(1),
});

export const DataDescribeTableOutputSchema = z.object({
  database: z.string(),
  schema: z.string(),
  table: z.string(),
  columns: z.array(
    z.object({
      name: z.string(),
      type: z.string().optional(),
      nullable: z.boolean().optional(),
    }),
  ),
});

export type DataDescribeTableInput = z.infer<typeof DataDescribeTableInputSchema>;
export type DataDescribeTableOutput = z.infer<typeof DataDescribeTableOutputSchema>;

