import { z } from 'zod';

import { TransparencyLogSummarySchema } from './common.js';

export const ListTransparencyLogsInputSchema = z.object({
  limit: z.coerce.number().int().positive().max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const ListTransparencyLogsOutputSchema = z.object({
  transparency_logs: z.array(TransparencyLogSummarySchema),
});
