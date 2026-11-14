import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { buildRateLimitMiddleware } from '../../src/app/middleware/rate-limit.js';
import type { Env } from '../../src/infrastructure/config/env.js';

let testCounter = 0;

function createMockEnv(overrides: Partial<Env> = {}): Env {
  testCounter++;
  return {
    NODE_ENV: 'test',
    HOST: '0.0.0.0',
    PORT: 3000,
    LOG_LEVEL: 'info',
    SERVICE_NAME: `test-service-${testCounter}`,
    DATABASE_URL: 'file:./test.db',
    AUTH_MODE: 'api_key',
    OKTA_MODE: 'mock',
    REGISTRY_GRAPH_BACKEND: 'json_file',
    REGISTRY_ARTIFACT_BACKEND: 'fs',
    MAX_ROWS_DEFAULT: 50,
    MAX_ROWS_HARD_MAX: 500,
    TOOL_TIMEOUT_MS_DEFAULT: 15000,
    TOOL_TIMEOUT_MS_HARD_MAX: 60000,
    MAX_OUTPUT_BYTES: 65536,
    RATE_LIMIT_ENABLED: true,
    RATE_LIMIT_REQUESTS: 100,
    RATE_LIMIT_WINDOW_MS: 60000,
    ...overrides,
  } as Env;
}

function createMockRequest(options: {
  auth?: string;
  client?: string;
  ip?: string;
} = {}): Request {
  const headers = new Headers();
  if (options.auth) {
    headers.set('Authorization', `Bearer ${options.auth}`);
  }
  if (options.client) {
    headers.set('X-Agent-Client', options.client);
  }
  if (options.ip) {
    headers.set('X-Forwarded-For', options.ip);
  }
  return new Request('http://localhost/test', { headers });
}

describe('rate-limit middleware', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('allows requests under the limit', async () => {
    const app = new Hono();
    const env = createMockEnv({ RATE_LIMIT_REQUESTS: 5 });
    app.use('*', buildRateLimitMiddleware(env));
    app.get('/test', (c) => c.json({ ok: true }));

    for (let i = 0; i < 3; i++) {
      const res = await app.request(createMockRequest({ auth: 'test-token' }));
      expect(res.status).toBe(200);
    }
  });

  it('blocks requests over the limit', async () => {
    const app = new Hono();
    const env = createMockEnv({ RATE_LIMIT_REQUESTS: 2 });
    app.use('*', buildRateLimitMiddleware(env));
    app.get('/test', (c) => c.json({ ok: true }));

    await app.request(createMockRequest({ auth: 'test-token' }));
    await app.request(createMockRequest({ auth: 'test-token' }));
    const res = await app.request(createMockRequest({ auth: 'test-token' }));

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body).toMatchObject({ error: { code: 'RATE_LIMIT_EXCEEDED' } });
  });

  it('sets rate limit headers', async () => {
    const app = new Hono();
    const env = createMockEnv({ RATE_LIMIT_REQUESTS: 10 });
    app.use('*', buildRateLimitMiddleware(env));
    app.get('/test', (c) => c.json({ ok: true }));

    const res = await app.request(createMockRequest({ auth: 'test-token' }));

    expect(res.headers.get('X-RateLimit-Limit')).toBe('10');
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('9');
    expect(res.headers.get('X-RateLimit-Reset')).toMatch(/^\d+$/);
  });

  it('allows different clients separately', async () => {
    const app = new Hono();
    const env = createMockEnv({ RATE_LIMIT_REQUESTS: 2 });
    app.use('*', buildRateLimitMiddleware(env));
    app.get('/test', (c) => c.json({ ok: true }));

    await app.request(createMockRequest({ auth: 'token-a' }));
    await app.request(createMockRequest({ auth: 'token-a' }));
    const resA = await app.request(createMockRequest({ auth: 'token-a' }));
    expect(resA.status).toBe(429);

    const resB = await app.request(createMockRequest({ auth: 'token-b' }));
    expect(resB.status).toBe(200);
  });

  it('resets limit after window expires', async () => {
    const app = new Hono();
    const env = createMockEnv({ RATE_LIMIT_REQUESTS: 2, RATE_LIMIT_WINDOW_MS: 1000 });
    app.use('*', buildRateLimitMiddleware(env));
    app.get('/test', (c) => c.json({ ok: true }));

    await app.request(createMockRequest({ auth: 'test-token' }));
    await app.request(createMockRequest({ auth: 'test-token' }));
    const res1 = await app.request(createMockRequest({ auth: 'test-token' }));
    expect(res1.status).toBe(429);

    vi.advanceTimersByTime(1001);

    const res2 = await app.request(createMockRequest({ auth: 'test-token' }));
    expect(res2.status).toBe(200);
  });

  it('can be disabled via env', async () => {
    const app = new Hono();
    const env = createMockEnv({ RATE_LIMIT_ENABLED: false, RATE_LIMIT_REQUESTS: 1 });
    app.use('*', buildRateLimitMiddleware(env));
    app.get('/test', (c) => c.json({ ok: true }));

    for (let i = 0; i < 10; i++) {
      const res = await app.request(createMockRequest({ auth: 'test-token' }));
      expect(res.status).toBe(200);
    }
  });
});
