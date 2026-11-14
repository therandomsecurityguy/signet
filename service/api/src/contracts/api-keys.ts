import { z } from 'zod';

export const ApiKeyScopeSchema = z.enum(['read', 'write', 'lifecycle']);

export const ApiKeySummarySchema = z.object({
  key_id: z.string(),
  owner_label: z.string(),
  scopes: z.array(z.string()),
  created_at: z.string(),
  expires_at: z.string().nullable(),
  last_used_at: z.string().nullable(),
  created_by: z.string().nullable(),
  revoked_at: z.string().nullable(),
});

export const CreateApiKeyInputSchema = z.object({
  owner_label: z.string().min(1).max(200),
  scopes: z.array(ApiKeyScopeSchema).min(1).max(3).optional(),
  ttl_days: z.coerce.number().int().positive().max(3650).optional(),
});

export const CreateApiKeyOutputSchema = z.object({
  token: z.string(),
  api_key: ApiKeySummarySchema,
});

export const ListApiKeysOutputSchema = z.object({
  api_keys: z.array(ApiKeySummarySchema),
});

export const RevokeApiKeyOutputSchema = z.object({
  api_key: ApiKeySummarySchema,
});

export const RotateApiKeyOutputSchema = z.object({
  token: z.string(),
  api_key: ApiKeySummarySchema,
});

export type ApiKeySummary = z.infer<typeof ApiKeySummarySchema>;
export type CreateApiKeyInput = z.infer<typeof CreateApiKeyInputSchema>;
export type CreateApiKeyOutput = z.infer<typeof CreateApiKeyOutputSchema>;
export type ListApiKeysOutput = z.infer<typeof ListApiKeysOutputSchema>;
export type RevokeApiKeyOutput = z.infer<typeof RevokeApiKeyOutputSchema>;
export type RotateApiKeyOutput = z.infer<typeof RotateApiKeyOutputSchema>;
