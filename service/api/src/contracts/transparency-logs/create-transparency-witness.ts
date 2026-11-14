import { z } from 'zod';

import { TransparencyLogDetailsSchema } from './common.js';

export const CreateTransparencyWitnessInputSchema = z.object({
  witness_id: z.string().min(1).max(500),
  key_ref: z.string().min(1).max(500),
  witness_type: z.string().min(1).max(200).optional(),
  valid_from: z.string().min(1).max(100).optional(),
  valid_to: z.string().min(1).max(100).optional(),
});

export const CreateTransparencyWitnessOutputSchema = TransparencyLogDetailsSchema;
