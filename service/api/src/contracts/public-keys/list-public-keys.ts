import { z } from 'zod';

import { TrustedPublicKeySummarySchema } from './common.js';

export const ListTrustedPublicKeysInputSchema = z.object({
  limit: z.coerce.number().int().positive().max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const ListTrustedPublicKeysOutputSchema = z.object({
  public_keys: z.array(TrustedPublicKeySummarySchema),
});

export type ListTrustedPublicKeysInput = z.infer<typeof ListTrustedPublicKeysInputSchema>;
export type ListTrustedPublicKeysOutput = z.infer<typeof ListTrustedPublicKeysOutputSchema>;
