import type { ApiKeyPrincipal } from '../../domain/principal/principal.js';

export type ApiKeyMetadata = {
  key_id: string;
  owner_label: string;
  scopes: string[];
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  created_by: string | null;
  revoked_at: string | null;
};

export interface ApiKeyStore {
  resolve(token: string): Promise<ApiKeyPrincipal | null>;
  create(input: {
    owner_label: string;
    scopes?: string[];
    expires_at?: string | null;
    created_by?: string | null;
  }): Promise<{ token: string; principal: ApiKeyPrincipal; metadata: ApiKeyMetadata }>;
  list(): Promise<ApiKeyMetadata[]>;
  get(key_id: string): Promise<ApiKeyMetadata | null>;
  revoke(input: { key_id: string }): Promise<void>;
  /** Issue a fresh secret for an existing (non-revoked) key id. */
  rotate(input: { key_id: string }): Promise<{ token: string; metadata: ApiKeyMetadata } | null>;
}
