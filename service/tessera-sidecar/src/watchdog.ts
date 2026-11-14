// In-cluster watchdog probe for the tessera-sidecar (which publishes
// hard-depend on). Kept as a pure function so it is easy to test; the
// CronJob entry point lives in watchdog-main.ts.
//
// The Terraform alarm treats missing metric data as breaching, so a dead
// watchdog is itself an alert.

export type WatchdogResult = {
  healthy: boolean;
  detail: string;
};

export async function checkSidecar(input: {
  url: string;
  token?: string | undefined;
  fetchImpl?: typeof fetch;
}): Promise<WatchdogResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeout = AbortSignal.timeout(5000);
  try {
    const health = await fetchImpl(new URL('/healthz', input.url), { signal: timeout });
    if (!health.ok) return { healthy: false, detail: `healthz returned ${health.status}` };
    const config = await fetchImpl(new URL('/v1/config', input.url), {
      headers: input.token ? { authorization: `Bearer ${input.token}` } : {},
      signal: timeout,
    });
    if (!config.ok) return { healthy: false, detail: `config returned ${config.status}` };
    const payload = (await config.json()) as Record<string, unknown>;
    // When a token is configured the sidecar must be enforcing it; the
    // native log must be active in the deployment mode that relies on it.
    if (input.token && payload['auth_enabled'] !== true) {
      return { healthy: false, detail: 'auth is not enforced although a token is configured' };
    }
    if (payload['native_log_enabled'] === false) {
      return { healthy: false, detail: 'native log is disabled' };
    }
    return { healthy: true, detail: 'ok' };
  } catch (err) {
    return { healthy: false, detail: err instanceof Error ? err.message : 'probe failed' };
  }
}
