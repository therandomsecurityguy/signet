// Shared fetch wrapper for infrastructure endpoints: a per-attempt timeout
// plus bounded retries for transient failures (network errors and 5xx).
// 4xx responses are returned as-is — auth or validation failures are not
// retried. Keep in sync with service/registry/application/services/
// fetch-with-retry.ts (the sidecar package is standalone by design).

export type FetchWithRetryOptions = {
  timeoutMs?: number;
  retries?: number;
  backoffMs?: number;
};

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_RETRIES = 1;
const DEFAULT_BACKOFF_MS = 300;

export async function fetchWithRetry(
  input: URL | string,
  init: RequestInit = {},
  options: FetchWithRetryOptions = {},
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = options.retries ?? DEFAULT_RETRIES;
  const backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetchImpl(input, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status >= 500 && attempt < retries) {
        lastError = new Error(`upstream returned ${response.status}`);
      } else {
        return response;
      }
    } catch (err) {
      lastError = err;
    }
    if (attempt < retries) {
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('transparency sidecar request failed');
}
