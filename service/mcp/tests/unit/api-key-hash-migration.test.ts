import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { scryptSync } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';

import { buildAppDependencies } from '../../src/app/dependencies.js';
import { loadEnv } from '../../src/infrastructure/config/env.js';

async function buildTestDeps() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'mcp-key-hash-'));
  const env = loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: `file:${path.join(tmp, 'mcp.db')}`,
    REGISTRY_GRAPH_BACKEND: 'memory',
    REGISTRY_OBJECTS_DIR: path.join(tmp, 'objects'),
  });
  const deps = buildAppDependencies(env);
  await deps.ready();
  return { deps, tmp };
}

describe('mcp api key hash storage', () => {
  it('migrates legacy pepper-salted hashes on first resolve and keeps them verifiable', async () => {
    const { deps, tmp } = await buildTestDeps();
    try {
      const { token } = await deps.apiKeys.create({ owner_label: 'legacy-key' });
      const secret = token.split('_')[2] ?? '';
      const legacyHash = scryptSync(secret, 'signet-dev-pepper', 32).toString('hex');

      const db = await deps.db.getDb();
      await db.run('UPDATE api_keys SET key_hash = ?', legacyHash);

      await expect(deps.apiKeys.resolve(token)).resolves.toMatchObject({ type: 'api_key' });

      const row = (await db.get('SELECT key_hash FROM api_keys')) as { key_hash: string };
      expect(row.key_hash.startsWith('scrypt$')).toBe(true);
      expect(row.key_hash.split('$')[1]).toMatch(/^[0-9a-f]{32}$/);

      // The migrated hash still verifies on the next resolve.
      await expect(deps.apiKeys.resolve(token)).resolves.toMatchObject({ type: 'api_key' });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
