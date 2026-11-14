import { z } from 'zod';

export const DataSourceSchema = z.enum(['snowflake', 'athena', 'motherduck']);
export type DataSource = z.infer<typeof DataSourceSchema>;

