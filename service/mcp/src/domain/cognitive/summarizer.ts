const MAX_STRING = 120;
const MAX_ARRAY_PREVIEW = 3;
const MAX_OBJECT_PREVIEW_KEYS = 5;
const MAX_OBJECT_KEYS_LISTED = 10;
const MAX_DEPTH = 3;

/**
 * Produce a compact, deterministic summary of a result payload. The summary
 * preserves the top-level shape at a high level (counts + previews) so an agent
 * can still understand what the full result contained without paying the full
 * token cost.
 */
export function summarizeCompact(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[…]';
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;

  if (Array.isArray(value)) {
    return {
      _type: 'array',
      count: value.length,
      preview: value.slice(0, MAX_ARRAY_PREVIEW).map((item) => summarizeCompact(item, depth + 1)),
    };
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    const preview: Record<string, unknown> = {};
    for (const key of keys.slice(0, MAX_OBJECT_PREVIEW_KEYS)) {
      preview[key] = summarizeCompact(record[key], depth + 1);
    }
    return {
      _type: 'object',
      key_count: keys.length,
      keys: keys.slice(0, MAX_OBJECT_KEYS_LISTED),
      preview,
    };
  }

  return String(value);
}
