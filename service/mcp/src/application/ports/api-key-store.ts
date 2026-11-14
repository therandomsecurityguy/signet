import type { ApiKeyPrincipal } from '../../domain/principal/principal.js';

export interface ApiKeyStore {
  resolve(token: string): Promise<ApiKeyPrincipal | null>;
  create(input: { owner_label: string }): Promise<{ token: string; principal: ApiKeyPrincipal }>;
  revoke(input: { key_id: string }): Promise<void>;
}

