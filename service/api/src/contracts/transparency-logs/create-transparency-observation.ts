import { z } from 'zod';

export const CreateTransparencyObservationInputSchema = z.object({
  checkpoint_body: z.string().min(1).max(20_000).optional(),
  checkpoint_signature: z.string().min(1).max(20_000).optional(),
  signed_note: z.string().min(1).max(40_000).optional(),
  observed_from_type: z.enum(['log', 'witness', 'distributor', 'peer']),
  observed_from_id: z.string().min(1).max(500),
  observed_at: z.string().min(1).max(100).optional(),
  source_channel: z.string().min(1).max(500).optional(),
  observer_id: z.string().min(1).max(500).optional(),
  observer_type: z.string().min(1).max(200).optional(),
  relay_from_type: z.enum(['log', 'witness', 'distributor', 'peer']).optional(),
  relay_from_id: z.string().min(1).max(500).optional(),
  relay_hop_count: z.number().int().nonnegative().max(1000).optional(),
  source_checkpoint_occurred_at: z.string().min(1).max(100).optional(),
})
  .refine((value) => Boolean(value.signed_note || (value.checkpoint_body && value.checkpoint_signature)), {
    message: 'signed_note or checkpoint_body + checkpoint_signature is required',
  })
  .refine((value) => !(value.signed_note && (value.checkpoint_body || value.checkpoint_signature)), {
    message: 'signed_note cannot be combined with checkpoint_body or checkpoint_signature',
  });
