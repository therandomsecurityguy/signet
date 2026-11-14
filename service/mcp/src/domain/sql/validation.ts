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

  // Match keywords as whole words: substring matching previously rejected
  // legitimate identifiers such as `users` (contains USE) and OFFSET
  // (contains SET). This remains a defense-in-depth net behind the
  // entitlement rules, not a SQL parser.
  for (const kw of FORBIDDEN_KEYWORDS) {
    if (new RegExp(`(?<![A-Z0-9_])${kw}(?![A-Z0-9_])`, 'i').test(normalized)) {
      return { ok: false, reason: 'forbidden_keyword' };
    }
  }

  return { ok: true };
}

