import type { ApiKeyMetadata, ApiKeyStore } from '../ports/api-key-store.js';

export const API_KEY_SCOPES = ['read', 'write', 'lifecycle'] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export class ApiKeyUseCase {
  constructor(
    private readonly store: ApiKeyStore,
    private readonly defaultTtlDays: number,
  ) {}

  async create(input: {
    owner_label: string;
    scopes?: string[];
    ttl_days?: number;
    created_by?: string | null;
  }): Promise<{ token: string; metadata: ApiKeyMetadata }> {
    const { token, metadata } = await this.store.create({
      owner_label: input.owner_label,
      scopes: normalizeScopes(input.scopes),
      expires_at: expiryFromTtlDays(input.ttl_days ?? this.defaultTtlDays),
      created_by: input.created_by ?? null,
    });
    return { token, metadata };
  }

  async list(): Promise<ApiKeyMetadata[]> {
    return await this.store.list();
  }

  async revoke(key_id: string): Promise<void> {
    await this.store.revoke({ key_id });
  }

  async rotate(key_id: string): Promise<{ token: string; metadata: ApiKeyMetadata } | null> {
    return await this.store.rotate({ key_id });
  }
}

function normalizeScopes(scopes?: string[]): string[] {
  const allowed = new Set<string>(API_KEY_SCOPES);
  const requested = (scopes && scopes.length > 0 ? scopes : ['read']).map((s) => s.trim()).filter(Boolean);
  const invalid = requested.filter((s) => !allowed.has(s));
  if (invalid.length > 0) {
    throw new Error(`Unknown scope(s): ${invalid.join(', ')}`);
  }
  return [...new Set(requested)];
}

function expiryFromTtlDays(ttlDays: number): string | null {
  if (!Number.isFinite(ttlDays) || ttlDays <= 0) return null;
  return new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString();
}
