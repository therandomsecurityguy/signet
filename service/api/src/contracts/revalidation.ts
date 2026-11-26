import { z } from 'zod';

import { FreshnessSchema } from './freshness.js';

// Recertification queue + revalidation jobs (build plan 2.1). The queue is
// derived on read from version freshness; jobs are durable records of a
// bounded, non-destructive revalidation run.

export const RecertificationStateSchema = z.enum(['due', 'approaching']);

export const RecertificationQueueItemSchema = z.object({
  publication_urn: z.string(),
  entity_type: z.enum(['SKILL_VERSION', 'AGENT_VERSION']),
  logical_key: z.string(),
  version: z.number().int(),
  lifecycle_status: z.string(),
  freshness: FreshnessSchema,
  last_revalidated_at: z.string().nullable(),
  revalidation_status: z.string().nullable(),
  recertification_state: RecertificationStateSchema,
  /** Freshness reasons plus `revalidation_failed` when the last run failed. */
  reasons: z.array(z.string()),
});

export const RecertificationQueueOutputSchema = z.object({
  items: z.array(RecertificationQueueItemSchema),
  total: z.number().int(),
  due_count: z.number().int(),
  approaching_count: z.number().int(),
});

export const CreateRevalidationJobInputSchema = z.object({
  job_id: z.string().min(1).max(200),
  author: z.string().min(1).max(200),
  /** Which queue states to revalidate; `due` covers expired/stale/failed. */
  scope: z.enum(['due', 'approaching', 'all']).default('due'),
  entity_type: z.enum(['skill', 'agent', 'all']).default('all'),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

export const RecertificationQueueQuerySchema = z.object({
  state: z.enum(['due', 'approaching', 'all']).default('all'),
  entity_type: z.enum(['skill', 'agent', 'all']).default('all'),
  limit: z.coerce.number().int().positive().max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const ExecuteRevalidationJobInputSchema = z.object({
  author: z.string().min(1).max(200),
});

export const RevalidationJobSummarySchema = z.object({
  urn: z.string(),
  properties: z.record(z.string(), z.unknown()),
});

export const CreateRevalidationJobOutputSchema = z.object({
  revalidation_job: RevalidationJobSummarySchema,
  created: z.boolean(),
});

export const ExecuteRevalidationJobOutputSchema = z.object({
  revalidation_job: RevalidationJobSummarySchema,
});

export const GetRevalidationJobOutputSchema = z.object({
  revalidation_job: RevalidationJobSummarySchema,
});

export const ListRevalidationJobsOutputSchema = z.object({
  jobs: z.array(RevalidationJobSummarySchema),
});

export type RecertificationQueueItem = z.infer<typeof RecertificationQueueItemSchema>;
export type RecertificationQueueOutput = z.infer<typeof RecertificationQueueOutputSchema>;
export type CreateRevalidationJobInput = z.infer<typeof CreateRevalidationJobInputSchema>;
export type ExecuteRevalidationJobInput = z.infer<typeof ExecuteRevalidationJobInputSchema>;
export type RevalidationJobSummary = z.infer<typeof RevalidationJobSummarySchema>;
