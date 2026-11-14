import { z } from 'zod';

const IsoDateTimeSchema = z.string().min(1).refine((value) => !Number.isNaN(Date.parse(value)), {
  message: 'Expected ISO-like datetime string.',
});

export const TimeAwareSummarySchema = z.object({
  urn: z.string(),
  properties: z.record(z.string(), z.unknown()),
});

export const TimeAwareCommitDetailsSchema = z.object({
  commit: TimeAwareSummarySchema,
  parent_commits: z.array(TimeAwareSummarySchema),
  child_commits: z.array(TimeAwareSummarySchema),
  manifests: z.array(TimeAwareSummarySchema),
  blobs: z.array(TimeAwareSummarySchema),
  refs: z.array(TimeAwareSummarySchema),
  tags: z.array(TimeAwareSummarySchema),
  workspaces: z.array(TimeAwareSummarySchema),
});

export const TimeAwareRefDetailsSchema = z.object({
  ref: TimeAwareSummarySchema,
  target_commit: TimeAwareSummarySchema.nullable(),
  target_commit_parents: z.array(TimeAwareSummarySchema),
});

export const TimeAwareTagDetailsSchema = z.object({
  tag: TimeAwareSummarySchema,
  target_commit: TimeAwareSummarySchema.nullable(),
  target_commit_parents: z.array(TimeAwareSummarySchema),
});

export const TimeAwareWorkspaceDetailsSchema = z.object({
  workspace: TimeAwareSummarySchema,
  base_commit: TimeAwareSummarySchema.nullable(),
  base_commit_parents: z.array(TimeAwareSummarySchema),
});

export const TimeAwareRetentionRootAnalysisSchema = z.object({
  retention_root: TimeAwareSummarySchema,
  direct_commits: z.array(TimeAwareSummarySchema),
  reachable_commits: z.array(TimeAwareSummarySchema),
  reachable_manifests: z.array(TimeAwareSummarySchema),
  direct_blobs: z.array(TimeAwareSummarySchema),
  reachable_blobs: z.array(TimeAwareSummarySchema),
  refs: z.array(TimeAwareSummarySchema),
  tags: z.array(TimeAwareSummarySchema),
  workspaces: z.array(TimeAwareSummarySchema),
});

export const TimeAwareGcPlanReasonSchema = z.object({
  code: z.string(),
  detail: z.string(),
  related_urns: z.array(z.string()),
});

export const TimeAwareGcPlanItemSchema = z.object({
  object: TimeAwareSummarySchema,
  reasons: z.array(TimeAwareGcPlanReasonSchema),
});

export const TimeAwareGcPlanBlockerSchema = z.object({
  blocker_kind: z.enum(['REF', 'TAG', 'WORKSPACE', 'RETENTION_ROOT']),
  blocker: TimeAwareSummarySchema,
  reasons: z.array(TimeAwareGcPlanReasonSchema),
});

export const TimeAwareGcPlanPreviewSchema = z.object({
  retention_root: TimeAwareSummarySchema,
  protected_commits: z.array(TimeAwareGcPlanItemSchema),
  protected_manifests: z.array(TimeAwareGcPlanItemSchema),
  protected_blobs: z.array(TimeAwareGcPlanItemSchema),
  candidate_manifests: z.array(TimeAwareGcPlanItemSchema),
  candidate_blobs: z.array(TimeAwareGcPlanItemSchema),
  blockers: z.array(TimeAwareGcPlanBlockerSchema),
});

export const TimeAwareCommitFilterSchema = z.object({
  commit_urn: z.string().min(1).optional(),
  valid_at: IsoDateTimeSchema.optional(),
  transaction_as_of: IsoDateTimeSchema.optional(),
});

export const TimeAwareBaseCommitFilterSchema = z.object({
  base_commit_urn: z.string().min(1).optional(),
  valid_at: IsoDateTimeSchema.optional(),
  transaction_as_of: IsoDateTimeSchema.optional(),
});

export const TimeAwareTemporalQuerySchema = z.object({
  valid_at: IsoDateTimeSchema.optional(),
  transaction_as_of: IsoDateTimeSchema.optional(),
});

export type TimeAwareSummary = z.infer<typeof TimeAwareSummarySchema>;
