import pg from 'pg';

import type { Db } from './db.js';

export type PgQueryable = {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
  end(): Promise<void>;
};

export function translatePlaceholders(sql: string, paramCount: number): string {
  if (paramCount === 0) return sql;

  let out = '';
  let index = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i] as string;

    if (inSingleQuote || inDoubleQuote) {
      out += ch;
      if (ch === (inSingleQuote ? "'" : '"') && sql[i + 1] === ch) {
        out += ch;
        i += 1;
      } else if (ch === (inSingleQuote ? "'" : '"')) {
        inSingleQuote = false;
        inDoubleQuote = false;
      }
      continue;
    }

    if (ch === "'") {
      inSingleQuote = true;
      out += ch;
      continue;
    }
    if (ch === '"') {
      inDoubleQuote = true;
      out += ch;
      continue;
    }
    if (ch === '?') {
      index += 1;
      out += `$${index}`;
      continue;
    }
    out += ch;
  }

  return out;
}

export function withSslRootCert(connectionString: string, certPath: string): string {
  const queryStart = connectionString.indexOf('?');
  const base = queryStart === -1 ? connectionString : connectionString.slice(0, queryStart);
  const query = queryStart === -1 ? '' : connectionString.slice(queryStart + 1);

  const params = query
    .split('&')
    .filter((pair) => pair.length > 0)
    .filter((pair) => {
      const key = pair.split('=', 1)[0] ?? '';
      return key !== 'sslmode' && key !== 'sslrootcert';
    });

  params.push('sslmode=verify-full');
  params.push(`sslrootcert=${encodeURIComponent(certPath)}`);
  return `${base}?${params.join('&')}`;
}

export class PgDb implements Db {
  constructor(private readonly client: PgQueryable) {}

  async exec(sql: string): Promise<void> {
    await this.client.query(sql);
  }

  async run(sql: string, ...params: unknown[]): Promise<{ changes: number }> {
    const result = await this.client.query(translatePlaceholders(sql, params.length), params);
    return { changes: result.rowCount ?? 0 };
  }

  async get<T = unknown>(sql: string, ...params: unknown[]): Promise<T | undefined> {
    const result = await this.client.query(translatePlaceholders(sql, params.length), params);
    return result.rows[0] as T | undefined;
  }

  async all<T = unknown>(sql: string, ...params: unknown[]): Promise<T> {
    const result = await this.client.query(translatePlaceholders(sql, params.length), params);
    return result.rows as T;
  }

  async close(): Promise<void> {
    await this.client.end();
  }
}

export async function openPgDb(
  connectionString: string,
  options: { sslRootCertPath?: string | undefined } = {},
): Promise<Db> {
  const target = options.sslRootCertPath
    ? withSslRootCert(connectionString, options.sslRootCertPath)
    : connectionString;
  const client = new pg.Client({ connectionString: target });
  await client.connect();
  return new PgDb(client);
}
