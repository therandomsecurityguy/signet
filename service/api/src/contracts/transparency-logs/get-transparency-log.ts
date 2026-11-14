import { z } from 'zod';

import { TransparencyLogDetailsSchema } from './common.js';

export const GetTransparencyLogInputSchema = z.object({
  log_id: z.string().min(1).max(500),
});

export const GetTransparencyLogOutputSchema = TransparencyLogDetailsSchema;
