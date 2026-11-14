import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

import type { ApiKeyMetadata, ApiKeyStore } from '../../application/ports/api-key-store.js';
import { REGISTRY_WRITE_SCOPES } from '../../domain/principal/scopes.js';
import type { ApiKeyPrincipal } from '../../domain/principal/principal.js';
import type { Db } from '../persistence/db.js';

type ApiKeyRow = {
  key_id: string;
  key_hash: string;
  owner_label: string;
  scopes: string | null;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  created_by: string | null;
  revoked_at: string | null;
};

const SELECT_COLUMNS =
  'key_id, key_hash, owner_label, scopes, created_at, expires_at, last_used_at, created_by, revoked_at';

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
      `SELECT ${SELECT_COLUMNS} FROM api_keys WHERE key_id = ?`,
      parsed.keyId,
    );

    // Always perform a constant-time comparison (against a dummy when absent)
    // so timing does not reveal whether the key id exists.
    const storedBuf = Buffer.from(row?.key_hash ?? dummyHashHex(), 'hex');
    const matched = secretHashCandidates(parsed.secret, this.options.pepper).some((hex) => {
      const candidateBuf = Buffer.from(hex, 'hex');
      return candidateBuf.length === storedBuf.length && timingSafeEqual(candidateBuf, storedBuf);
    });

    if (!row || !matched || row.revoked_at !== null) return null;
    if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) return null;

    const now = new Date().toISOString();
    await db.run('UPDATE api_keys SET last_used_at = ? WHERE key_id = ?', now, row.key_id).catch(() => undefined);

    return toPrincipal(row, parsed.keyId);
  }

  async create(input: {
    owner_label: string;
    scopes?: string[];
    expires_at?: string | null;
    created_by?: string | null;
  }): Promise<{ token: string; principal: ApiKeyPrincipal; metadata: ApiKeyMetadata }> {
    const keyId = randomBytes(9).toString('hex');
    const secret = randomBytes(24).toString('hex');
    const token = `agk_${keyId}_${secret}`;
    const createdAt = new Date().toISOString();
    // New keys default to the full write taxonomy (parity with the
    // pre-scopes behavior); callers may pass a narrower list explicitly.
    const scopes = input.scopes ?? [...REGISTRY_WRITE_SCOPES];
    const expiresAt = input.expires_at ?? null;

    const db = await this.dbProvider.getDb();
    await db.run(
      `INSERT INTO api_keys (key_id, key_hash, owner_label, scopes, created_at, expires_at, last_used_at, created_by, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL)`,
      keyId,
      hashSecret(secret, this.options.pepper),
      input.owner_label,
      JSON.stringify(scopes),
      createdAt,
      expiresAt,
      input.created_by ?? null,
    );

    const metadata: ApiKeyMetadata = {
      key_id: keyId,
      owner_label: input.owner_label,
      scopes,
      created_at: createdAt,
      expires_at: expiresAt,
      last_used_at: null,
      created_by: input.created_by ?? null,
      revoked_at: null,
    };

    return {
      token,
      principal: {
        type: 'api_key',
        id: keyId,
        displayName: input.owner_label,
        scopes,
        groups: [],
        claims: {},
        authMethod: 'api_key',
      },
      metadata,
    };
  }

  async list(): Promise<ApiKeyMetadata[]> {
    const db = await this.dbProvider.getDb();
    const rows = await db.all<ApiKeyRow[]>(
      `SELECT ${SELECT_COLUMNS} FROM api_keys ORDER BY created_at DESC`,
    );
    return rows.map(toMetadata);
  }

  async get(key_id: string): Promise<ApiKeyMetadata | null> {
    const db = await this.dbProvider.getDb();
    const row = await db.get<ApiKeyRow>(`SELECT ${SELECT_COLUMNS} FROM api_keys WHERE key_id = ?`, key_id);
    return row ? toMetadata(row) : null;
  }

  async revoke(input: { key_id: string }): Promise<void> {
    const db = await this.dbProvider.getDb();
    await db.run(
      'UPDATE api_keys SET revoked_at = ? WHERE key_id = ? AND revoked_at IS NULL',
      new Date().toISOString(),
      input.key_id,
    );
  }

  async rotate(input: { key_id: string }): Promise<{ token: string; metadata: ApiKeyMetadata } | null> {
    const db = await this.dbProvider.getDb();
    const row = await db.get<ApiKeyRow>(`SELECT ${SELECT_COLUMNS} FROM api_keys WHERE key_id = ?`, input.key_id);
    if (!row || row.revoked_at !== null) return null;

    const secret = randomBytes(24).toString('hex');
    const token = `agk_${input.key_id}_${secret}`;
    await db.run(
      'UPDATE api_keys SET key_hash = ?, last_used_at = NULL WHERE key_id = ?',
      hashSecret(secret, this.options.pepper),
      input.key_id,
    );
    return { token, metadata: toMetadata(row) };
  }
}

function toMetadata(row: ApiKeyRow): ApiKeyMetadata {
  return {
    key_id: row.key_id,
    owner_label: row.owner_label,
    scopes: parseScopes(row.scopes),
    created_at: row.created_at,
    expires_at: row.expires_at,
    last_used_at: row.last_used_at,
    created_by: row.created_by,
    revoked_at: row.revoked_at,
  };
}

function toPrincipal(row: ApiKeyRow, keyId: string): ApiKeyPrincipal {
  return {
    type: 'api_key',
    id: keyId,
    displayName: row.owner_label,
    scopes: parseScopes(row.scopes),
    groups: [],
    claims: {},
    authMethod: 'api_key',
  };
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
  // Strong KDF (scrypt) so the stored value is not a fast SHA-based digest.
  // The pepper (required in production) is the salt; the constant is a
  // dev-only fallback.
  const salt = pepper ?? 'cachet-dev-pepper';
  return scryptSync(secret, salt, 32).toString('hex');
}

/** Hex hash of a presented secret to compare against the stored hash. */
function secretHashCandidates(secret: string, pepper: string | undefined): string[] {
  return [hashSecret(secret, pepper)];
}

function dummyHashHex(): string {
  return '0'.repeat(64);
}
