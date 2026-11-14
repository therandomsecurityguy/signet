import { loadEnv } from '../src/infrastructure/config/env.js';
import { createDbProvider } from '../src/infrastructure/persistence/db-provider.js';
import { SqliteApiKeyStore } from '../src/infrastructure/auth/sqlite-api-key-store.js';
import { ApiKeyUseCase } from '../src/application/usecases/api-keys.js';

function readArg(name: string): string | undefined {
  const idx = process.argv.findIndex((v) => v === `--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

async function main() {
  const owner_label = readArg('owner-label');
  if (!owner_label) {
    console.error(
      'Usage: node --import tsx scripts/create-api-key.ts --owner-label "Jane Doe" [--scopes read,write] [--ttl-days 90]',
    );
    process.exitCode = 2;
    return;
  }

  const scopes = readArg('scopes')
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const ttlDaysRaw = readArg('ttl-days');
  const ttl_days = ttlDaysRaw ? Number(ttlDaysRaw) : undefined;

  const env = loadEnv();
  const db = createDbProvider(env.DATABASE_URL);
  await db.ready();

  const store = new SqliteApiKeyStore(db, env.API_KEY_PEPPER ? { pepper: env.API_KEY_PEPPER } : {});
  const apiKeys = new ApiKeyUseCase(store, env.API_KEY_DEFAULT_TTL_DAYS);
  const { token, metadata } = await apiKeys.create({
    owner_label,
    ...(scopes ? { scopes } : {}),
    ...(typeof ttl_days === 'number' && Number.isFinite(ttl_days) ? { ttl_days } : {}),
  });

  console.log(
    JSON.stringify(
      {
        token,
        key_id: metadata.key_id,
        owner_label: metadata.owner_label,
        scopes: metadata.scopes,
        expires_at: metadata.expires_at,
      },
      null,
      2,
    ),
  );
}

await main();
