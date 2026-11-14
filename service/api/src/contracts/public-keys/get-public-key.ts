import { z } from 'zod';

import { TrustedPublicKeyDetailsSchema } from './common.js';

export const GetTrustedPublicKeyInputSchema = z.object({
  key_ref: z.string().min(1).max(500),
});

export const GetTrustedPublicKeyOutputSchema = TrustedPublicKeyDetailsSchema;

export type GetTrustedPublicKeyInput = z.infer<typeof GetTrustedPublicKeyInputSchema>;
export type GetTrustedPublicKeyOutput = z.infer<typeof GetTrustedPublicKeyOutputSchema>;
