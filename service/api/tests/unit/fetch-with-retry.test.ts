import { describe, expect, it } from 'vitest';

import { fetchWithRetry } from '../../../registry/application/services/fetch-with-retry.js';

function jsonResponse(status: number): Response {
  return new Response('{}', { status, headers: { 'content-type': 'application/json' } });
}

describe('fetchWithRetry', () => {
  it('returns the first response when it succeeds', async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return jsonResponse(200);
    };
    const response = await fetchWithRetry('http://sidecar.test/v1', {}, {}, fetchImpl);
    expect(response.status).toBe(200);
    expect(calls).toBe(1);
  });

  it('retries a 5xx once and returns the eventual success', async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return calls === 1 ? jsonResponse(503) : jsonResponse(200);
    };
    const response = await fetchWithRetry('http://sidecar.test/v1', {}, { backoffMs: 1 }, fetchImpl);
    expect(response.status).toBe(200);
    expect(calls).toBe(2);
  });

  it('returns the final 5xx response after exhausting the retry budget', async () => {
    // Callers translate !response.ok into their own errors, so the helper
    // surfaces the last response instead of throwing its own.
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return jsonResponse(500);
    };
    const response = await fetchWithRetry('http://sidecar.test/v1', {}, { backoffMs: 1 }, fetchImpl);
    expect(response.status).toBe(500);
    expect(calls).toBe(2);
  });

  it('does not retry 4xx responses', async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return jsonResponse(401);
    };
    const response = await fetchWithRetry('http://sidecar.test/v1', {}, { backoffMs: 1 }, fetchImpl);
    expect(response.status).toBe(401);
    expect(calls).toBe(1);
  });

  it('aborts a hanging attempt on the per-attempt timeout and surfaces the failure', async () => {
    let observedAbort = false;
    const fetchImpl: typeof fetch = async (_input, init) => {
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          observedAbort = true;
          reject(new Error('aborted'));
          return;
        }
        signal?.addEventListener('abort', () => {
          observedAbort = true;
          reject(new Error('aborted'));
        });
      });
    };
    await expect(
      fetchWithRetry('http://sidecar.test/v1', {}, { timeoutMs: 50, retries: 0 }, fetchImpl),
    ).rejects.toThrow();
    expect(observedAbort).toBe(true);
  });

  it('recovers when the first attempt errors at the network level', async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      if (calls === 1) throw new Error('connect ECONNREFUSED');
      return jsonResponse(200);
    };
    const response = await fetchWithRetry('http://sidecar.test/v1', {}, { backoffMs: 1 }, fetchImpl);
    expect(response.status).toBe(200);
    expect(calls).toBe(2);
  });
});
