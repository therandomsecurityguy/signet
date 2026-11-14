import { z } from 'zod';

import { TimeAwareSummarySchema } from './common.js';

export const CreateGcJobInputSchema = z.object({
  job_id: z.string().min(1).max(200),
  author: z.string().min(1).max(200),
  retention_root_ids: z.array(z.string().min(1).max(500)).min(1).max(100),
  grace_period_days: z.number().int().min(0).optional(),
});

export const ExecuteGcJobInputSchema = z.object({
  author: z.string().min(1).max(200),
});

export const CreateGcJobOutputSchema = z.object({
  gc_job: TimeAwareSummarySchema,
  created: z.boolean(),
});

export type CreateGcJobInput = z.infer<typeof CreateGcJobInputSchema>;
export type ExecuteGcJobInput = z.infer<typeof ExecuteGcJobInputSchema>;
