export const migration_0001_init = {
  id: '0001_init',
  up: [
    `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);
`.trim(),
    `
CREATE TABLE IF NOT EXISTS api_keys (
  key_id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL,
  owner_label TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT NULL
);
`.trim(),
    // Shared by service/api and service/mcp: both planes write audit_events
    // when DATABASE_URL points at the same database.
    `
CREATE TABLE IF NOT EXISTS audit_events (
  audit_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  request_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  principal_type TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  auth_method TEXT NOT NULL,
  path TEXT NULL,
  method TEXT NULL,
  tool_name TEXT NULL,
  tool_version TEXT NULL,
  data_source TEXT NULL,
  input_sha256 TEXT NULL,
  input_preview_redacted TEXT NULL,
  policy_effect TEXT NOT NULL,
  policy_reason TEXT NOT NULL,
  limits_applied TEXT NOT NULL,
  error_code TEXT NULL
);
`.trim(),
    `CREATE INDEX IF NOT EXISTS idx_audit_events_occurred_at ON audit_events (occurred_at DESC);`,
    `CREATE INDEX IF NOT EXISTS idx_audit_events_principal ON audit_events (principal_id, occurred_at DESC);`,
    `CREATE INDEX IF NOT EXISTS idx_audit_events_path ON audit_events (path, occurred_at DESC);`,
    `CREATE INDEX IF NOT EXISTS idx_audit_events_tool ON audit_events (tool_name, occurred_at DESC);`,
    `CREATE INDEX IF NOT EXISTS idx_audit_events_source ON audit_events (data_source, occurred_at DESC);`,
  ] as const,
} as const;
