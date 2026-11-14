import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

import type { ApiKeyStore } from '../../application/ports/api-key-store.js';
import type { ApiKeyPrincipal } from '../../domain/principal/principal.js';
import type { Db } from '../persistence/db.js';

type ApiKeyRow = {
  key_id: string;
  key_hash: string;
  owner_label: string;
  scopes: string | null;
  expires_at: string | null;
  revoked_at: string | null;
};

export class SqliteApiKeyStore implements ApiKeyStore {
  constructor(
    private readonly dbProvider: { getDb(): Promise<Db> },
    private readonly options: { pepper?: string } = {},
  ) {}

  async resolve(token: string): Promise<ApiKeyPrincipal | null> {
    const parsed = parseApiKeyToken(token);
    if (!parsed) return null;

    const db = await this.dbProvider.getDb();
    const row = await db.get<ApiKeyRow>(
      'SELECT key_id, key_hash, owner_label, scopes, expires_at, revoked_at FROM api_keys WHERE key_id = ?',
      parsed.keyId,
    );

    const storedBuf = Buffer.from(row?.key_hash ?? dummyHashHex(), 'hex');
    const matched = secretHashCandidates(parsed.secret, this.options.pepper).some((hex) => {
      const candidateBuf = Buffer.from(hex, 'hex');
      return candidateBuf.length === storedBuf.length && timingSafeEqual(candidateBuf, storedBuf);
    });

    if (!row || !matched || row.revoked_at !== null) return null;
    if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) return null;

    return {
      type: 'api_key',
      id: row.key_id,
      displayName: row.owner_label,
      scopes: parseScopes(row.scopes),
      groups: [],
      claims: {},
      authMethod: 'api_key',
    };
  }

  async create(input: { owner_label: string }): Promise<{ token: string; principal: ApiKeyPrincipal }> {
    // Use hex so the underscore separator is unambiguous.
    const keyId = randomBytes(9).toString('hex');
    const secret = randomBytes(24).toString('hex');
    const token = `agk_${keyId}_${secret}`;

    const db = await this.dbProvider.getDb();

    await db.run(
      `
INSERT INTO api_keys (key_id, key_hash, owner_label, scopes, created_at, revoked_at)
VALUES (?, ?, ?, '[]', ?, NULL)
`.trim(),
      keyId,
      hashSecret(secret, this.options.pepper),
      input.owner_label,
      new Date().toISOString(),
    );

    return {
      token,
      principal: {
        type: 'api_key',
        id: keyId,
        displayName: input.owner_label,
        scopes: [],
        groups: [],
        claims: {},
        authMethod: 'api_key',
      },
    };
  }

  async revoke(input: { key_id: string }): Promise<void> {
    const db = await this.dbProvider.getDb();
    await db.run(
      'UPDATE api_keys SET revoked_at = ? WHERE key_id = ?',
      new Date().toISOString(),
      input.key_id,
    );
  }
}

function parseScopes(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

function parseApiKeyToken(token: string): { keyId: string; secret: string } | null {
  if (!token.startsWith('agk_')) return null;
  const parts = token.split('_');
  if (parts.length !== 3) return null;
  const keyId = parts[1];
  const secret = parts[2];
  if (!keyId || !secret) return null;
  return { keyId, secret };
}

function hashSecret(secret: string, pepper: string | undefined): string {
  // Strong KDF (scrypt); the pepper (required in production) is the salt, with
  // a dev-only fallback.
  const salt = pepper ?? 'signet-dev-pepper';
  return scryptSync(secret, salt, 32).toString('hex');
}

function secretHashCandidates(secret: string, pepper: string | undefined): string[] {
  return [hashSecret(secret, pepper)];
}

function dummyHashHex(): string {
  return '0'.repeat(64);
}
