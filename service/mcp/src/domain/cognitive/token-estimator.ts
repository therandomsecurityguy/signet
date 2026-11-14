/**
 * Deterministic token estimator. Uses the common ~4-chars-per-token heuristic
 * over the JSON-serialized payload. This is intentionally simple and stable so
 * the budget guard is reproducible in tests.
 */
export function estimateTokens(value: unknown): number {
  const json = safeStringify(value);
  return Math.ceil(json.length / 4);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}
