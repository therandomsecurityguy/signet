import { z } from 'zod';

import { TrustedPublicKeyDetailsSchema } from './common.js';

export const RevokeTrustedPublicKeyInputSchema = z.object({
  author: z.string().min(1).max(200),
  reason: z.string().min(1).max(2_000).optional(),
});

export const RevokeTrustedPublicKeyOutputSchema = TrustedPublicKeyDetailsSchema;

export type RevokeTrustedPublicKeyInput = z.infer<typeof RevokeTrustedPublicKeyInputSchema>;
export type RevokeTrustedPublicKeyOutput = z.infer<typeof RevokeTrustedPublicKeyOutputSchema>;
