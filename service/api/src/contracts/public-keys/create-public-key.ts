import { z } from 'zod';

import { TrustedPublicKeyDetailsSchema } from './common.js';

export const CreateTrustedPublicKeyInputSchema = z.object({
  key_ref: z.string().min(1).max(500),
  algorithm: z.string().min(1).max(100),
  public_key_pem: z.string().min(1).max(20_000),
  owner: z.string().min(1).max(200).optional(),
  trust_scope: z.string().min(1).max(500).optional(),
  valid_from: z.string().min(1).max(100).optional(),
  valid_to: z.string().min(1).max(100).optional(),
  transparency_log_ref: z.string().min(1).max(1_000).optional(),
  inclusion_proof_ref: z.string().min(1).max(2_000).optional(),
  supersedes_key_ref: z.string().min(1).max(500).optional(),
});

export const CreateTrustedPublicKeyOutputSchema = TrustedPublicKeyDetailsSchema;

export type CreateTrustedPublicKeyInput = z.infer<typeof CreateTrustedPublicKeyInputSchema>;
export type CreateTrustedPublicKeyOutput = z.infer<typeof CreateTrustedPublicKeyOutputSchema>;
