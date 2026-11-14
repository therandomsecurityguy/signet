import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { buildAppDependencies } from '../../src/app/dependencies.js';
import { buildApp } from '../../src/app/server.js';
import { loadEnv } from '../../src/infrastructure/config/env.js';

async function buildTestApp(overrides: Record<string, string> = {}) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'api-keys-'));
  const env = loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    AUTH_MODE: 'dual',
    OKTA_MODE: 'mock',
    OKTA_ADMIN_GROUPS: 'app_signet_admin',
    DATABASE_URL: `file:${path.join(tmp, 'api.db')}`,
    REGISTRY_GRAPH_BACKEND: 'memory',
    REGISTRY_OBJECTS_DIR: path.join(tmp, 'objects'),
    ...overrides,
  });
  const deps = buildAppDependencies(env);
  await deps.ready();
  const app = buildApp(deps);
  return { app, deps, tmp };
}

const adminHeaders = { Authorization: 'Bearer admin-okta-token', 'content-type': 'application/json' };

describe('self-serve API keys', () => {
  it('requires a human admin (Okta) principal to manage keys', async () => {
    const { deps, tmp } = await buildTestApp();
    try {
      const app = buildApp(deps);
      // No auth → 401 from Okta admin guard.
      const noAuth = await app.request('/v1/api-keys');
      expect(noAuth.status).toBe(401);

      // An API key may not manage API keys → 403.
      const { token } = await deps.apiKeys.create({ owner_label: 'robot' });
      const viaApiKey = await app.request('/v1/api-keys', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(viaApiKey.status).toBe(403);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('mints a key once, lists metadata, rotates and revokes', async () => {
    const { app, deps, tmp } = await buildTestApp();
    try {
      const created = await app.request('/v1/api-keys', {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({ owner_label: 'agent-x', scopes: ['read', 'write'] }),
      });
      expect(created.status).toBe(201);
      const createdBody = (await created.json()) as { token: string; api_key: { key_id: string; scopes: string[] } };
      expect(createdBody.token).toMatch(/^agk_/);
      expect(createdBody.api_key.scopes).toEqual(['read', 'write']);
      const keyId = createdBody.api_key.key_id;

      // List shows metadata but never the secret.
      const list = await app.request('/v1/api-keys', { headers: adminHeaders });
      const listBody = (await list.json()) as { api_keys: Array<{ key_id: string }> };
      expect(listBody.api_keys.some((k) => k.key_id === keyId)).toBe(true);
      expect(JSON.stringify(listBody)).not.toContain(createdBody.token);

      // The minted key resolves.
      expect(await deps.apiKeys.resolve(createdBody.token)).not.toBeNull();

      // Rotate: old secret stops working, new one works.
      const rotated = await app.request(`/v1/api-keys/${keyId}/rotate`, { method: 'POST', headers: adminHeaders });
      expect(rotated.status).toBe(200);
      const rotatedBody = (await rotated.json()) as { token: string };
      expect(rotatedBody.token).not.toBe(createdBody.token);
      expect(await deps.apiKeys.resolve(createdBody.token)).toBeNull();
      expect(await deps.apiKeys.resolve(rotatedBody.token)).not.toBeNull();

      // Revoke: the key stops resolving.
      const revoked = await app.request(`/v1/api-keys/${keyId}`, { method: 'DELETE', headers: adminHeaders });
      expect(revoked.status).toBe(200);
      expect(await deps.apiKeys.resolve(rotatedBody.token)).toBeNull();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('enforces write scope and expiry', async () => {
    const { app, deps, tmp } = await buildTestApp({
      API_KEY_DEFAULT_TTL_DAYS: '1',
      SCOPE_ENFORCEMENT: 'enforce',
    });
    try {
      const created = await app.request('/v1/api-keys', {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({ owner_label: 'reader', scopes: ['read'] }),
      });
      const { token } = (await created.json()) as { token: string };

      // Read-scoped key cannot write once scope enforcement is on.
      const write = await app.request('/v1/skills', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ skill_key: 'skill:nope', artifact: { content: 'x', original_path: 's.md' } }),
      });
      expect(write.status).toBe(403);
      await expect(write.json()).resolves.toMatchObject({ error: { code: 'INSUFFICIENT_SCOPE' } });

      // Expired keys do not resolve.
      const expired = await deps.apiKeys.create({ owner_label: 'expired', expires_at: new Date(Date.now() - 1000).toISOString() });
      expect(await deps.apiKeys.resolve(expired.token)).toBeNull();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
