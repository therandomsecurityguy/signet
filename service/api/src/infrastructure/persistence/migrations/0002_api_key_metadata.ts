export const migration_0002_api_key_metadata = {
  id: '0002_api_key_metadata',
  up: [
    // Add self-serve metadata to api_keys: scopes, expiry, last use, creator.
    `ALTER TABLE api_keys ADD COLUMN scopes TEXT NOT NULL DEFAULT '[]';`,
    `ALTER TABLE api_keys ADD COLUMN expires_at TEXT NULL;`,
    `ALTER TABLE api_keys ADD COLUMN last_used_at TEXT NULL;`,
    `ALTER TABLE api_keys ADD COLUMN created_by TEXT NULL;`,
  ],
};
