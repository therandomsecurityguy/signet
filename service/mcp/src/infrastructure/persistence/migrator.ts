import type { Db } from './db.js';
import { migrations } from './migrations/index.js';

export async function runMigrations(db: Db): Promise<void> {
  await db.exec(
    `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);
`.trim(),
  );

  const appliedRows = await db.all<{ id: string }[]>(
    'SELECT id FROM schema_migrations',
  );
  const applied = new Set(appliedRows.map((r) => r.id));

  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;

    await db.exec('BEGIN');
    try {
      for (const statement of migration.up) {
        await db.exec(statement);
      }
      await db.run(
        'INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)',
        migration.id,
        new Date().toISOString(),
      );
      await db.exec('COMMIT');
    } catch (err) {
      await db.exec('ROLLBACK');
      throw err;
    }
  }
}

