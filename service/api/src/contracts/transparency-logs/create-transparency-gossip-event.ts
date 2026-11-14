import { z } from 'zod';

export const CreateTransparencyGossipEventInputSchema = z.object({
  from_witness_id: z.string().min(1).max(500),
  to_witness_id: z.string().min(1).max(500),
  checkpoint_artifact_urn: z.string().min(1).max(2_000),
  occurred_at: z.string().min(1).max(100).optional(),
  source_channel: z.string().min(1).max(500).optional(),
  relayed_by_id: z.string().min(1).max(500).optional(),
  relay_hop_count: z.number().int().nonnegative().max(1000).optional(),
  source_checkpoint_occurred_at: z.string().min(1).max(100).optional(),
});
