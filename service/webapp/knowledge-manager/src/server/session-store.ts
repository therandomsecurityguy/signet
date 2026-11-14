import { randomUUID } from 'node:crypto';

import type { SqliteDb } from './persistence/db.js';
import { openSqliteDb } from './persistence/db.js';

export type OperatorSession = {
  id: string;
  apiToken: string;
  principalType: 'api_key' | 'okta_user';
  principalId: string;
  principalEmail?: string;
  principalDisplayName?: string;
  groups: string[];
  scopes: string[];
  // Per-session CSRF token, rendered as a hidden form field and verified on
  // every state-changing request.
  csrfToken: string;
  authMethod: 'api_key' | 'okta_access_token';
  createdAt: string;
  expiresAt: string;
};

export interface OperatorSessionStore {
  create(input: {
    apiToken: string;
    principalType: 'api_key' | 'okta_user';
    principalId: string;
    principalEmail?: string;
    principalDisplayName?: string;
    groups: string[];
    scopes?: string[];
    authMethod: 'api_key' | 'okta_access_token';
  }): Promise<OperatorSession>;
  get(sessionId: string): Promise<OperatorSession | null>;
  delete(sessionId: string): Promise<void>;
}

export class InMemoryOperatorSessionStore implements OperatorSessionStore {
  private readonly sessions = new Map<string, OperatorSession>();

  constructor(private readonly cfg: { ttlMinutes: number }) {}

  create(input: {
    apiToken: string;
    principalType: 'api_key' | 'okta_user';
    principalId: string;
    principalEmail?: string;
    principalDisplayName?: string;
    groups: string[];
    scopes?: string[];
    authMethod: 'api_key' | 'okta_access_token';
  }): Promise<OperatorSession> {
    this.pruneExpired();

    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.cfg.ttlMinutes * 60_000);
    const session: OperatorSession = {
      id: randomUUID(),
      apiToken: input.apiToken,
      principalType: input.principalType,
      principalId: input.principalId,
      ...(input.principalEmail ? { principalEmail: input.principalEmail } : {}),
      ...(input.principalDisplayName ? { principalDisplayName: input.principalDisplayName } : {}),
      groups: input.groups,
      scopes: input.scopes ?? [],
      csrfToken: randomUUID(),
      authMethod: input.authMethod,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };

    this.sessions.set(session.id, session);
    return Promise.resolve(session);
  }

  get(sessionId: string): Promise<OperatorSession | null> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return Promise.resolve(null);
    }

    if (Date.parse(session.expiresAt) <= Date.now()) {
      this.sessions.delete(sessionId);
      return Promise.resolve(null);
    }

    return Promise.resolve(session);
  }

  delete(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
    return Promise.resolve();
  }

  private pruneExpired() {
    for (const [sessionId, session] of this.sessions.entries()) {
      if (Date.parse(session.expiresAt) <= Date.now()) {
        this.sessions.delete(sessionId);
      }
    }
  }
}

export class SqliteOperatorSessionStore implements OperatorSessionStore {
  constructor(
    private readonly db: SqliteDb,
    private readonly cfg: { ttlMinutes: number },
  ) {}

  static async create(input: {
    databaseUrl: string;
    ttlMinutes: number;
  }): Promise<SqliteOperatorSessionStore> {
    const db = await openSqliteDb(input.databaseUrl);
    await db.exec(
      `
CREATE TABLE IF NOT EXISTS webapp_sessions (
  id TEXT PRIMARY KEY,
  api_token TEXT NOT NULL,
  principal_type TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  principal_email TEXT,
  principal_display_name TEXT,
  groups TEXT NOT NULL DEFAULT '[]',
  scopes TEXT NOT NULL DEFAULT '[]',
  csrf_token TEXT NOT NULL DEFAULT '',
  auth_method TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
`.trim(),
    );
    // Sessions created before the CSRF/scope columns existed are upgraded in
    // place; duplicate-column errors mean the schema is already current.
    for (const column of ['scopes', 'csrf_token']) {
      try {
        await db.exec(`ALTER TABLE webapp_sessions ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`);
      } catch {
        // Column already exists.
      }
    }
    return new SqliteOperatorSessionStore(db, { ttlMinutes: input.ttlMinutes });
  }

  async create(input: {
    apiToken: string;
    principalType: 'api_key' | 'okta_user';
    principalId: string;
    principalEmail?: string;
    principalDisplayName?: string;
    groups: string[];
    scopes?: string[];
    authMethod: 'api_key' | 'okta_access_token';
  }): Promise<OperatorSession> {
    await this.deleteExpired();

    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.cfg.ttlMinutes * 60_000);
    const session: OperatorSession = {
      id: randomUUID(),
      apiToken: input.apiToken,
      principalType: input.principalType,
      principalId: input.principalId,
      ...(input.principalEmail ? { principalEmail: input.principalEmail } : {}),
      ...(input.principalDisplayName ? { principalDisplayName: input.principalDisplayName } : {}),
      groups: input.groups,
      scopes: input.scopes ?? [],
      csrfToken: randomUUID(),
      authMethod: input.authMethod,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };

    await this.db.run(
      `
INSERT INTO webapp_sessions (
  id, api_token, principal_type, principal_id, principal_email, principal_display_name, groups, scopes, csrf_token, auth_method, created_at, expires_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `.trim(),
      session.id,
      session.apiToken,
      session.principalType,
      session.principalId,
      session.principalEmail ?? null,
      session.principalDisplayName ?? null,
      JSON.stringify(session.groups),
      JSON.stringify(session.scopes),
      session.csrfToken,
      session.authMethod,
      session.createdAt,
      session.expiresAt,
    );

    return session;
  }

  async get(sessionId: string): Promise<OperatorSession | null> {
    const row = await this.db.get<{
      id: string;
      api_token: string;
      principal_type: 'api_key' | 'okta_user';
      principal_id: string;
      principal_email: string | null;
      principal_display_name: string | null;
      groups: string | null;
      scopes: string | null;
      csrf_token: string | null;
      auth_method: 'api_key' | 'okta_access_token';
      created_at: string;
      expires_at: string;
    }>(
      `
SELECT
  id,
  api_token,
  principal_type,
  principal_id,
  principal_email,
  principal_display_name,
  groups,
  scopes,
  csrf_token,
  auth_method,
  created_at,
  expires_at
FROM webapp_sessions
WHERE id = ?
      `.trim(),
      sessionId,
    );

    if (!row) {
      return null;
    }

    if (Date.parse(row.expires_at) <= Date.now()) {
      await this.delete(sessionId);
      return null;
    }

    return {
      id: row.id,
      apiToken: row.api_token,
      principalType: row.principal_type,
      principalId: row.principal_id,
      ...(row.principal_email ? { principalEmail: row.principal_email } : {}),
      ...(row.principal_display_name ? { principalDisplayName: row.principal_display_name } : {}),
      groups: parseGroups(row.groups),
      scopes: parseGroups(row.scopes),
      csrfToken: row.csrf_token ?? '',
      authMethod: row.auth_method,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }

  async delete(sessionId: string): Promise<void> {
    await this.db.run('DELETE FROM webapp_sessions WHERE id = ?', sessionId);
  }

  private async deleteExpired() {
    await this.db.run('DELETE FROM webapp_sessions WHERE expires_at <= ?', new Date().toISOString());
  }
}

function parseGroups(raw: string | null): string[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}
