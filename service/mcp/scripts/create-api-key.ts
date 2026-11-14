import { loadEnv } from '../src/infrastructure/config/env.js';
import { createDbProvider } from '../src/infrastructure/persistence/db-provider.js';
import { SqliteApiKeyStore } from '../src/infrastructure/auth/sqlite-api-key-store.js';

async function main() {
  const ownerIdx = process.argv.findIndex((v) => v === '--owner-label');
  const owner_label = ownerIdx >= 0 ? process.argv[ownerIdx + 1] : undefined;

  if (!owner_label) {
    console.error('Usage: node --import tsx scripts/create-api-key.ts --owner-label "Jane Doe"');
    process.exitCode = 2;
    return;
  }

  const env = loadEnv();
  const db = createDbProvider(env.DATABASE_URL);
  await db.ready();

  const store = new SqliteApiKeyStore(db);
  const { token, principal } = await store.create({ owner_label });

  console.log(JSON.stringify({ token, key_id: principal.id, owner_label }, null, 2));
}

await main();

