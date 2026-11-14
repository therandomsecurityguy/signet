import { describe, expect, it } from 'vitest';
import { scryptSync } from 'node:crypto';

import { buildAppDependencies } from '../../src/app/dependencies.js';
import { loadEnv } from '../../src/infrastructure/config/env.js';

async function buildTestDeps(overrides: NodeJS.ProcessEnv = {}) {
  const env = loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: ':memory:',
    REGISTRY_GRAPH_BACKEND: 'memory',
    ...overrides,
  });
  const deps = buildAppDependencies(env);
  await deps.ready();
  return deps;
}

describe('api key hash storage', () => {
  it('stores new keys with a per-key salt and resolves them', async () => {
    const deps = await buildTestDeps();
    const { token } = await deps.apiKeys.create({ owner_label: 'salt-key' });
    const db = await deps.db.getDb();
    const row = (await db.get('SELECT key_hash FROM api_keys')) as { key_hash: string };

    expect(row.key_hash.startsWith('scrypt$')).toBe(true);
    const salt = row.key_hash.split('$')[1] ?? '';
    expect(salt).toMatch(/^[0-9a-f]{32}$/);

    await expect(deps.apiKeys.resolve(token)).resolves.toMatchObject({ type: 'api_key' });
  });

  it('migrates legacy pepper-salted hashes on first successful resolve', async () => {
    const deps = await buildTestDeps();
    const { token } = await deps.apiKeys.create({ owner_label: 'legacy-key' });
    const secret = token.split('_')[2] ?? '';
    const legacyHash = scryptSync(secret, 'signet-dev-pepper', 32).toString('hex');

    const db = await deps.db.getDb();
    await db.run('UPDATE api_keys SET key_hash = ?', legacyHash);

    await expect(deps.apiKeys.resolve(token)).resolves.toMatchObject({ type: 'api_key' });

    // The stored hash was upgraded in place and still verifies afterwards.
    const row = (await db.get('SELECT key_hash FROM api_keys')) as { key_hash: string };
    expect(row.key_hash.startsWith('scrypt$')).toBe(true);
    await expect(deps.apiKeys.resolve(token)).resolves.toMatchObject({ type: 'api_key' });
  });

  it('rejects a wrong secret against a legacy hash', async () => {
    const deps = await buildTestDeps();
    const { token } = await deps.apiKeys.create({ owner_label: 'legacy-wrong' });
    const [prefix, keyId, secret] = token.split('_');
    const legacyHash = scryptSync(secret ?? '', 'signet-dev-pepper', 32).toString('hex');

    const db = await deps.db.getDb();
    await db.run('UPDATE api_keys SET key_hash = ?', legacyHash);

    const wrongToken = `${prefix}_${keyId}_${'0'.repeat(48)}`;
    await expect(deps.apiKeys.resolve(wrongToken)).resolves.toBeNull();
  });
});
