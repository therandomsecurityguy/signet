import { z } from 'zod';

import { TransparencyLogDetailsSchema } from './common.js';

export const CreateTransparencyLogInputSchema = z.object({
  log_id: z.string().min(1).max(500),
  origin: z.string().min(1).max(500),
  checkpoint_key_ref: z.string().min(1).max(500),
  log_type: z.string().min(1).max(200).optional(),
  trust_scope: z.string().min(1).max(500).optional(),
  valid_from: z.string().min(1).max(100).optional(),
  valid_to: z.string().min(1).max(100).optional(),
  witness_quorum: z.number().int().min(0).max(1000).optional(),
});

export const CreateTransparencyLogOutputSchema = TransparencyLogDetailsSchema;
