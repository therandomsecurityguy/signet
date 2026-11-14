import { z } from 'zod';

import { TimeAwareSummarySchema } from './common.js';

export const CreateDraftWorkspaceFromRefInputSchema = z.object({
  owner: z.string().min(1).max(200),
  expires_at: z.string().min(1).optional(),
  promotion_path: z.string().min(1).optional(),
});

export const ListWorkspacesOutputSchema = z.object({
  workspaces: z.array(TimeAwareSummarySchema),
});

export const CreateDraftWorkspaceFromRefOutputSchema = z.object({
  workspace: TimeAwareSummarySchema,
  created: z.boolean(),
});

export type CreateDraftWorkspaceFromRefInput = z.infer<typeof CreateDraftWorkspaceFromRefInputSchema>;
