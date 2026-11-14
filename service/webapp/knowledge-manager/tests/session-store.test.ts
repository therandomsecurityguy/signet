import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { openSqliteDb } from '../src/server/persistence/db.js';
import { SqliteOperatorSessionStore } from '../src/server/session-store.js';

describe('sqlite operator session store', () => {
  it('persists sessions across store recreation', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'knowledge-manager-session-'));
    try {
      const databaseUrl = `file:${path.join(tmp, 'knowledge-manager.db')}`;
      const store = await SqliteOperatorSessionStore.create({
        databaseUrl,
        ttlMinutes: 60,
      });

      const created = await store.create({
        apiToken: 'agk_local_token',
        principalType: 'api_key',
        principalId: 'writer-1',
        authMethod: 'api_key',
        groups: [],
      });

      const reopened = await SqliteOperatorSessionStore.create({
        databaseUrl,
        ttlMinutes: 60,
      });
      const loaded = await reopened.get(created.id);

      expect(loaded).toMatchObject({
        id: created.id,
        apiToken: 'agk_local_token',
        principalType: 'api_key',
        principalId: 'writer-1',
        authMethod: 'api_key',
        groups: [],
      });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('rejects expired sessions and cleans them up', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'knowledge-manager-expired-'));
    try {
      const databaseUrl = `file:${path.join(tmp, 'knowledge-manager.db')}`;
      const store = await SqliteOperatorSessionStore.create({
        databaseUrl,
        ttlMinutes: 60,
      });

      const created = await store.create({
        apiToken: 'webapp-okta-token',
        principalType: 'okta_user',
        principalId: 'okta-user-1',
        authMethod: 'okta_access_token',
        groups: [],
      });

      const db = await openSqliteDb(databaseUrl);
      await db.run('UPDATE webapp_sessions SET expires_at = ? WHERE id = ?', '2000-01-01T00:00:00.000Z', created.id);

      const loaded = await store.get(created.id);
      expect(loaded).toBeNull();

      const row = await db.get<{ count: number }>('SELECT COUNT(*) AS count FROM webapp_sessions WHERE id = ?', created.id);
      expect(row?.count).toBe(0);
      await db.close();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('deletes persisted sessions explicitly', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'knowledge-manager-delete-'));
    try {
      const databaseUrl = `file:${path.join(tmp, 'knowledge-manager.db')}`;
      const store = await SqliteOperatorSessionStore.create({
        databaseUrl,
        ttlMinutes: 60,
      });

      const created = await store.create({
        apiToken: 'token-delete',
        principalType: 'api_key',
        principalId: 'writer-2',
        authMethod: 'api_key',
        groups: [],
      });

      await store.delete(created.id);
      await expect(store.get(created.id)).resolves.toBeNull();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
