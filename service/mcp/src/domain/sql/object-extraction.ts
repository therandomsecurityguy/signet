export type SqlObjectRef = {
  database?: string;
  schema?: string;
  table: string;
};

// Conservative extractor for Stage 2:
// - handles simple FROM/JOIN patterns
// - does not attempt full SQL parsing
// - intended to be replaced by a real parser later
export function extractTableRefs(sql: string): SqlObjectRef[] {
  const normalized = sql.replace(/\s+/g, ' ');
  const refs: SqlObjectRef[] = [];

  const regex = /\b(from|join)\s+([A-Za-z0-9_."-]+)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(normalized)) !== null) {
    const raw = m[2];
    if (!raw) continue;
    const cleaned = raw.replace(/"/g, '');
    const parts = cleaned.split('.').filter(Boolean);

    if (parts.length === 1) {
      const table = parts[0];
      if (table) refs.push({ table });
    } else if (parts.length === 2) {
      const schema = parts[0];
      const table = parts[1];
      if (schema && table) refs.push({ schema, table });
    } else {
      const database = parts[parts.length - 3];
      const schema = parts[parts.length - 2];
      const table = parts[parts.length - 1];
      if (!database || !schema || !table) continue;
      refs.push({
        database,
        schema,
        table,
      });
    }
  }

  return dedupe(refs);
}

function dedupe(refs: SqlObjectRef[]): SqlObjectRef[] {
  const seen = new Set<string>();
  const out: SqlObjectRef[] = [];
  for (const r of refs) {
    const key = `${r.database ?? ''}.${r.schema ?? ''}.${r.table}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

