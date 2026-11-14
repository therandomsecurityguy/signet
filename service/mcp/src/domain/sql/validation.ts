const FORBIDDEN_KEYWORDS = [
  'INSERT',
  'UPDATE',
  'DELETE',
  'MERGE',
  'CREATE',
  'ALTER',
  'DROP',
  'TRUNCATE',
  'GRANT',
  'REVOKE',
  'COPY',
  'UNLOAD',
  'CALL',
  'PUT',
  'GET',
  'USE',
  'SET',
] as const;

export type SqlValidationResult =
  | { ok: true }
  | { ok: false; reason: string };

export function validateReadOnlySql(sql: string): SqlValidationResult {
  const trimmed = sql.trim();
  if (!trimmed) return { ok: false, reason: 'empty_sql' };

  // Conservative v1: deny SQL comments entirely to avoid bypasses.
  if (trimmed.includes('--') || trimmed.includes('/*') || trimmed.includes('*/')) {
    return { ok: false, reason: 'sql_comments_not_allowed' };
  }

  // Single statement only (allow one trailing semicolon).
  const segments = trimmed
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (segments.length !== 1) return { ok: false, reason: 'multiple_statements' };

  const statement = segments[0];
  if (!statement) return { ok: false, reason: 'empty_sql' };
  const normalized = statement.toUpperCase();
  const startsReadOnly =
    normalized.startsWith('SELECT') || normalized.startsWith('WITH');
  if (!startsReadOnly) return { ok: false, reason: 'not_read_only' };

  for (const kw of FORBIDDEN_KEYWORDS) {
    if (normalized.includes(kw)) return { ok: false, reason: 'forbidden_keyword' };
  }

  return { ok: true };
}

