import { z } from 'zod';

export const CreateTransparencyCheckpointInputSchema = z.object({
  checkpoint_body: z.string().min(1).max(20_000).optional(),
  checkpoint_signature: z.string().min(1).max(20_000).optional(),
  signed_note: z.string().min(1).max(40_000).optional(),
  consistency_proof: z
    .object({
      previous_tree_size: z.number().int().positive(),
      previous_root_hash: z.string().min(1).max(2_000),
      proof_hashes: z.array(z.string().min(1).max(2_000)).max(10_000),
    })
    .optional(),
  witness_attestations: z
    .array(
      z.object({
        witness_id: z.string().min(1).max(500),
        signature: z.string().min(1).max(20_000),
      }),
    )
    .max(1000)
    .optional(),
  transparency_log_ref: z.string().min(1).max(1_000).optional(),
})
  .refine((value) => Boolean(value.signed_note || (value.checkpoint_body && value.checkpoint_signature)), {
    message: 'signed_note or checkpoint_body + checkpoint_signature is required',
  })
  .refine((value) => !(value.signed_note && (value.checkpoint_body || value.checkpoint_signature)), {
    message: 'signed_note cannot be combined with checkpoint_body or checkpoint_signature',
  });

export const TransparencyLogVerificationSchema = z.object({
  transparency_log: z.object({
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
    witnesses: z.array(
      z.object({
        witness_urn: z.string(),
        witness_id: z.string(),
        key_ref: z.string(),
        trust_status: z.string().optional(),
      }),
    ),
  }),
  checkpoint_signature_valid: z.boolean(),
  checkpoint_consistency_verified: z.boolean(),
  trusted_checkpoint_key_resolved: z.boolean(),
  witness_quorum_required: z.number(),
  witness_quorum_met: z.boolean(),
  witness_checks: z.array(
    z.object({
      witness_id: z.string(),
      trusted_witness_resolved: z.boolean(),
      trusted_key_resolved: z.boolean(),
      signature_valid: z.boolean(),
      note_cosignature_verified: z.boolean().optional(),
      verification_status: z.enum(['verified', 'missing_witness', 'missing_key', 'cryptographic_failure']),
    }),
  ),
  checkpoint_history: z.array(
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
  observations: z.array(
    z.object({
      observation_artifact_urn: z.string(),
      observed_from_type: z.enum(['log', 'witness', 'distributor', 'peer']),
      observed_from_id: z.string(),
      observed_at: z.string(),
      checkpoint_artifact_urn: z.string(),
      tree_size: z.number(),
      root_hash: z.string(),
      note_format: z.enum(['raw_signed_note', 'normalized_checkpoint']).optional(),
      parse_strategy: z.enum(['signed_note', 'checkpoint_body_signature']).optional(),
      payload_sha256: z.string().optional(),
      source_channel: z.string().optional(),
      observer_id: z.string().optional(),
      observer_type: z.string().optional(),
      relay_from_type: z.enum(['log', 'witness', 'distributor', 'peer']).optional(),
      relay_from_id: z.string().optional(),
      relay_hop_count: z.number().optional(),
      relayed_from_event_urn: z.string().optional(),
      source_checkpoint_occurred_at: z.string().optional(),
    }),
  ),
  disagreements: z.array(
    z.object({
      disagreement_id: z.string(),
      log_id: z.string(),
      kind: z.enum([
        'same_size_different_root',
        'inconsistent_chain',
        'witness_disagreement',
        'witness_equivocation',
        'checkpoint_regression',
        'quorum_drift',
      ]),
      left_checkpoint_artifact_urn: z.string(),
      right_checkpoint_artifact_urn: z.string(),
      reason: z.string(),
      occurred_at: z.string().optional(),
      tree_size: z.number().optional(),
      source_ids: z.array(z.string()).optional(),
    }),
  ),
  gossip_events: z.array(
    z.object({
      gossip_event_urn: z.string(),
      log_id: z.string(),
      from_witness_id: z.string(),
      to_witness_id: z.string(),
      checkpoint_artifact_urn: z.string(),
      occurred_at: z.string(),
      event_type: z.enum(['checkpoint_gossip']),
      note_format: z.enum(['raw_signed_note', 'normalized_checkpoint']).optional(),
      parse_strategy: z.enum(['signed_note', 'checkpoint_body_signature']).optional(),
      payload_sha256: z.string().optional(),
      source_channel: z.string().optional(),
      relayed_by_id: z.string().optional(),
      relay_hop_count: z.number().optional(),
      relayed_from_event_urn: z.string().optional(),
      source_checkpoint_occurred_at: z.string().optional(),
    }),
  ),
  verification_status: z.enum([
    'verified',
    'missing_checkpoint',
    'missing_checkpoint_key',
    'checkpoint_signature_invalid',
    'consistency_failure',
    'witness_quorum_unmet',
  ]),
});
