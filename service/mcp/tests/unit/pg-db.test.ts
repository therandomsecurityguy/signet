import { describe, expect, it } from 'vitest';

import { PgDb, translatePlaceholders, withSslRootCert } from '../../src/infrastructure/persistence/pg-db.js';

class FakeClient {
  queries: { sql: string; params: unknown[] | undefined }[] = [];
  rows: unknown[] = [];
  rowCount: number | null = 0;
  ended = false;

  async query(sql: string, params?: unknown[]) {
    this.queries.push({ sql, params });
    return { rows: this.rows, rowCount: this.rowCount };
  }

  async end(): Promise<void> {
    this.ended = true;
  }
}

describe('translatePlaceholders', () => {
  it('leaves parameterless SQL untouched', () => {
    expect(translatePlaceholders("SELECT '?' AS q", 0)).toBe("SELECT '?' AS q");
  });

  it('numbers ? placeholders for postgres', () => {
    expect(translatePlaceholders('SELECT * FROM t WHERE a = ? AND b = ?', 2)).toBe(
      'SELECT * FROM t WHERE a = $1 AND b = $2',
    );
  });

  it('does not touch ? inside quoted literals or identifiers', () => {
    expect(
      translatePlaceholders("UPDATE t SET a = ?, b = 'lit?eral', c = \"col?umn\" WHERE d = ?", 2),
    ).toBe("UPDATE t SET a = $1, b = 'lit?eral', c = \"col?umn\" WHERE d = $2");
  });

  it('handles doubled-quote escapes', () => {
    expect(translatePlaceholders("INSERT INTO t VALUES (?, 'it''s?', \"we\"\"ird?\")", 1)).toBe(
      "INSERT INTO t VALUES ($1, 'it''s?', \"we\"\"ird?\")",
    );
  });
});

describe('withSslRootCert', () => {
  it('pins verify-full and adds sslrootcert while keeping other params', () => {
    expect(
      withSslRootCert('postgresql://u:p@h:5432/d?sslmode=require&application_name=x', '/etc/ca.pem'),
    ).toBe('postgresql://u:p@h:5432/d?application_name=x&sslmode=verify-full&sslrootcert=%2Fetc%2Fca.pem');
  });

  it('adds a query string when there is none', () => {
    expect(withSslRootCert('postgresql://u:p@h:5432/d', '/etc/ca.pem')).toBe(
      'postgresql://u:p@h:5432/d?sslmode=verify-full&sslrootcert=%2Fetc%2Fca.pem',
    );
  });

  it('replaces existing sslmode and sslrootcert values instead of duplicating them', () => {
    expect(
      withSslRootCert('postgresql://u:p@h/d?sslrootcert=/old.pem&sslmode=require&sslmode=prefer', '/new.pem'),
    ).toBe('postgresql://u:p@h/d?sslmode=verify-full&sslrootcert=%2Fnew.pem');
  });

  it('leaves the authority and encoded credentials untouched', () => {
    const out = withSslRootCert('postgresql://user:pa%40ss@host:5432/db?sslmode=require', '/etc/ca.pem');
    expect(out.startsWith('postgresql://user:pa%40ss@host:5432/db?')).toBe(true);
  });
});

describe('PgDb', () => {
  it('run translates placeholders and reports changes', async () => {
    const client = new FakeClient();
    client.rowCount = 3;
    const db = new PgDb(client);

    expect(await db.run('UPDATE t SET a = ? WHERE b = ?', 'x', 'y')).toEqual({ changes: 3 });
    expect(client.queries).toEqual([
      { sql: 'UPDATE t SET a = $1 WHERE b = $2', params: ['x', 'y'] },
    ]);
  });

  it('run reports zero changes when rowCount is null', async () => {
    const client = new FakeClient();
    client.rowCount = null;
    const db = new PgDb(client);

    expect(await db.run('SELECT 1')).toEqual({ changes: 0 });
  });

  it('get returns the first row', async () => {
    const client = new FakeClient();
    client.rows = [{ id: 'a' }, { id: 'b' }];
    const db = new PgDb(client);

    expect(await db.get<{ id: string }>('SELECT * FROM t WHERE id = ?', 'a')).toEqual({ id: 'a' });
  });

  it('all returns every row', async () => {
    const client = new FakeClient();
    client.rows = [{ id: 'a' }, { id: 'b' }];
    const db = new PgDb(client);

    expect(await db.all<{ id: string }[]>('SELECT * FROM t')).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  it('exec runs statements without parameters', async () => {
    const client = new FakeClient();
    const db = new PgDb(client);

    await db.exec('CREATE TABLE t (id TEXT)');
    expect(client.queries).toEqual([{ sql: 'CREATE TABLE t (id TEXT)', params: undefined }]);
  });

  it('close ends the client', async () => {
    const client = new FakeClient();
    const db = new PgDb(client);

    await db.close();
    expect(client.ended).toBe(true);
  });
});
