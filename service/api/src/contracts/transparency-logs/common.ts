import { z } from 'zod';

export const TransparencyLogSummarySchema = z.object({
  log_urn: z.string(),
  log_id: z.string(),
  origin: z.string(),
  checkpoint_key_ref: z.string(),
  trust_status: z.string().optional(),
});

export const TransparencyLogDetailsSchema = z.object({
  transparency_log: z.object({
    urn: z.string(),
    properties: z.record(z.string(), z.unknown()),
  }),
  checkpoint_key: z
    .object({
      key_urn: z.string(),
      key_ref: z.string(),
    })
    .optional(),
  current_checkpoint: z
    .object({
      checkpoint_artifact_urn: z.string(),
      sha256: z.string().optional(),
      tree_size: z.number(),
      root_hash: z.string(),
      checkpoint_body: z.string(),
      checkpoint_signature: z.string(),
      checkpoint_signature_valid: z.boolean(),
      append_only_verified: z.boolean().optional(),
      witness_quorum_satisfied: z.boolean().optional(),
    })
    .optional(),
  checkpoints: z.array(
    z.object({
      checkpoint_artifact_urn: z.string(),
      sha256: z.string().optional(),
      tree_size: z.number(),
      root_hash: z.string(),
      checkpoint_body: z.string(),
      checkpoint_signature: z.string(),
      checkpoint_signature_valid: z.boolean(),
      append_only_verified: z.boolean().optional(),
      witness_quorum_satisfied: z.boolean().optional(),
    }),
  ),
  witnesses: z.array(
    z.object({
      witness_urn: z.string(),
      witness_id: z.string(),
      key_ref: z.string(),
      trust_status: z.string().optional(),
    }),
  ),
});
