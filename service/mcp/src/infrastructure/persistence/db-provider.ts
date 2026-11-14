import type { Db } from './db.js';
import { openSqliteDb } from './db.js';
import { openPgDb } from './pg-db.js';
import { runMigrations } from './migrator.js';

export type DbProvider = {
  ready(): Promise<void>;
  getDb(): Promise<Db>;
  close(): Promise<void>;
};

export function createDbProvider(
  databaseUrl: string,
  options: { sslRootCertPath?: string | undefined } = {},
): DbProvider {
  const usePostgres = /^postgres(ql)?:\/\//i.test(databaseUrl);
  let dbPromise: Promise<Db> | undefined;
  let readyPromise: Promise<void> | undefined;

  const getDb = async () => {
    if (!dbPromise) {
      dbPromise = usePostgres ? openPgDb(databaseUrl, options) : openSqliteDb(databaseUrl);
    }
    return await dbPromise;
  };

  const ready = async () => {
    if (!readyPromise) {
      readyPromise = (async () => {
        const db = await getDb();
        await runMigrations(db);
      })();
    }
    await readyPromise;
  };

  const close = async () => {
    if (!dbPromise) return;
    const db = await dbPromise;
    await db.close();
  };

  return { ready, getDb, close };
}
