import { z } from 'zod';

export const ReconcilePublicationTransparencyInputSchema = z.object({
  publication_urn: z.string().min(1),
});

const ReconciliationCheckSchema = z.object({
  name: z.string(),
  ok: z.boolean(),
  detail: z.string().optional(),
});

export const ReconcilePublicationTransparencyOutputSchema = z.object({
  publication_urn: z.string(),
  log_id: z.string(),
  reconciled_at: z.string(),
  status: z.enum(['verified', 'mismatch', 'incomplete']),
  evidence_artifact_urn: z.string(),
  evidence_sha256: z.string(),
  outcomes: z.array(
    z.object({
      source_type: z.enum(['publication_envelope', 'governance_event']),
      request_id: z.string(),
      request_record_sha256: z.string(),
      s3_uri: z.string(),
      status: z.enum(['verified', 'mismatch', 'not_submitted', 'fetch_failed']),
      tessera_entry_index: z.number().optional(),
      tessera_submission_status: z.enum(['staged_only', 'submitted']).optional(),
      checks: z.array(ReconciliationCheckSchema),
      error: z.string().optional(),
    }),
  ),
});

export type ReconcilePublicationTransparencyInput = z.infer<typeof ReconcilePublicationTransparencyInputSchema>;
