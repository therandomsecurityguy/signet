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
    PORT: 3100,
    LOG_LEVEL: 'info',
    SERVICE_NAME: `test-service-${testCounter}`,
    DATABASE_URL: 'file:./test.db',
    AUTH_MODE: 'api_key',
    OKTA_MODE: 'mock',
    REGISTRY_GRAPH_BACKEND: 'json_file',
    REGISTRY_ARTIFACT_BACKEND: 'fs',
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

  it('budgets failed authentications per client address', async () => {
    const app = new Hono();
    const env = createMockEnv({
      RATE_LIMIT_REQUESTS: 100,
      AUTH_FAILURE_LIMIT: 3,
      AUTH_FAILURE_WINDOW_MS: 60_000,
    });
    app.use('*', buildRateLimitMiddleware(env));
    app.get('/test', (c) =>
      c.req.header('Authorization') === 'Bearer good-token'
        ? c.json({ ok: true })
        : c.json({ error: { code: 'AUTH_UNAUTHENTICATED' } }, 401),
    );

    for (let i = 0; i < 3; i++) {
      const res = await app.request(createMockRequest({ auth: `bogus-${i}`, ip: '203.0.113.9' }));
      expect(res.status).toBe(401);
    }

    // A fresh guessed token would get its own per-credential bucket; the
    // per-address failure budget must still stop it.
    const blocked = await app.request(createMockRequest({ auth: 'bogus-4', ip: '203.0.113.9' }));
    expect(blocked.status).toBe(429);
    const blockedBody = await blocked.json();
    expect(blockedBody).toMatchObject({ error: { code: 'RATE_LIMIT_EXCEEDED' } });

    // Even valid credentials from the same address wait out the window.
    const stillBlocked = await app.request(createMockRequest({ auth: 'good-token', ip: '203.0.113.9' }));
    expect(stillBlocked.status).toBe(429);

    // Other addresses are unaffected.
    const other = await app.request(createMockRequest({ auth: 'good-token', ip: '203.0.113.10' }));
    expect(other.status).toBe(200);
  });
});
