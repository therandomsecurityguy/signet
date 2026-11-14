import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

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

    // Always perform a constant-time comparison (against a dummy when absent)
    // so timing does not reveal whether the key id exists.
    const storedHash = row?.key_hash ?? dummyHashHex();
    const matched = await verifySecret(parsed.secret, this.options.pepper, storedHash);

    if (!row || !matched || row.revoked_at !== null) return null;
    if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) return null;

    if (isLegacyHash(storedHash)) {
      // Opportunistic migration: re-hash the verified secret with the per-key
      // salt scheme so legacy rows upgrade on their first successful use.
      await db
        .run(
          'UPDATE api_keys SET key_hash = ? WHERE key_id = ?',
          await hashSecret(parsed.secret, this.options.pepper),
          row.key_id,
        )
        .catch(() => undefined);
    }

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
      await hashSecret(secret, this.options.pepper),
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

const scryptAsync = promisify(scrypt);

const HASH_SCHEME = 'scrypt';
const PER_KEY_SALT_BYTES = 16;

async function hashSecret(secret: string, pepper: string | undefined): Promise<string> {
  // scrypt$<saltHex>$<hashHex> with a random per-key salt; the pepper
  // (required in production) is mixed into the salt material so a database
  // leak alone cannot verify guesses. Computed asynchronously so auth load
  // cannot block the event loop.
  const salt = randomBytes(PER_KEY_SALT_BYTES).toString('hex');
  const derived = (await scryptAsync(secret, `${salt}:${pepper ?? 'signet-dev-pepper'}`, 32)) as Buffer;
  return `${HASH_SCHEME}$${salt}$${derived.toString('hex')}`;
}

function isLegacyHash(stored: string): boolean {
  return !stored.startsWith(`${HASH_SCHEME}$`);
}

async function verifySecret(
  secret: string,
  pepper: string | undefined,
  stored: string,
): Promise<boolean> {
  const pepperMaterial = pepper ?? 'signet-dev-pepper';
  if (isLegacyHash(stored)) {
    // Legacy format: the pepper (or dev constant) was the salt.
    const derived = (await scryptAsync(secret, pepperMaterial, 32)) as Buffer;
    return timingSafeHexEquals(derived, stored);
  }
  const [, salt, expectedHex] = stored.split('$');
  if (!salt || !expectedHex) return false;
  const derived = (await scryptAsync(secret, `${salt}:${pepperMaterial}`, 32)) as Buffer;
  return timingSafeHexEquals(derived, expectedHex);
}

function timingSafeHexEquals(derived: Buffer, expectedHex: string): boolean {
  const expected = Buffer.from(expectedHex, 'hex');
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

function dummyHashHex(): string {
  return '0'.repeat(64);
}
