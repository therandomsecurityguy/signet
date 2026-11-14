import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import sqlite3 from 'sqlite3';
import { open, type Database } from 'sqlite';

export type SqliteDb = Database<sqlite3.Database, sqlite3.Statement>;

export function parseSqliteFilename(databaseUrl: string): string {
  if (databaseUrl === ':memory:') return ':memory:';
  if (databaseUrl.startsWith('file:')) return databaseUrl.slice('file:'.length);
  if (databaseUrl.startsWith('sqlite://')) return databaseUrl.slice('sqlite://'.length);
  return databaseUrl;
}

export async function openSqliteDb(databaseUrl: string): Promise<SqliteDb> {
  const filename = parseSqliteFilename(databaseUrl);
  if (filename !== ':memory:') {
    await mkdir(dirname(filename), { recursive: true });
  }

  const db = await open({
    filename,
    driver: sqlite3.Database,
  });

  await db.exec('PRAGMA foreign_keys = ON;');
  return db;
}
