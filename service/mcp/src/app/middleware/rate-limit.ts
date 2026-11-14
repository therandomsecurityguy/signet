import { createHash } from 'node:crypto';

import type { MiddlewareHandler } from 'hono';

import type { Env } from '../../infrastructure/config/env.js';
import type { AppEnv } from '../server.js';
import {
  MemoryRateLimitStore,
  RedisRateLimitStore,
  ResilientRateLimitStore,
  type RateLimitStore,
} from './rate-limit-store.js';

function buildStore(env: Env): RateLimitStore {
  if (env.REDIS_URL) {
    // Redis-backed global limiter with an in-memory fallback so a Redis outage
    // degrades to per-instance limiting instead of bypassing the limit.
    return new ResilientRateLimitStore(
      new RedisRateLimitStore(env.REDIS_URL, env.SERVICE_NAME),
      new MemoryRateLimitStore(),
    );
  }
  return new MemoryRateLimitStore();
}

// Hash the caller credential before using it as a rate-limit key so no token
// material is ever persisted to the (external) rate-limit store.
function hashCredential(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function buildRateLimitMiddleware(env: Env): MiddlewareHandler<AppEnv> {
  if (!env.RATE_LIMIT_ENABLED) {
    return async (_c, next) => await next();
  }

  const store = buildStore(env);
  const limit = env.RATE_LIMIT_REQUESTS;
  const windowMs = env.RATE_LIMIT_WINDOW_MS;

  return async (c, next) => {
    const auth = c.req.header('Authorization');
    let key: string;

    if (auth) {
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
      key = `auth:${hashCredential(token)}`;
    } else {
      const client = c.req.header('X-Agent-Client');
      if (client) {
        key = `client:${client}`;
      } else {
        key = `ip:${c.req.header('X-Forwarded-For') ?? c.req.header('X-Real-IP') ?? 'unknown'}`;
      }
    }

    const { count, resetAt } = await store.increment(key, windowMs);
    const remaining = Math.max(0, limit - count);
    const reset = Math.ceil(resetAt / 1000);

    c.res.headers.set('X-RateLimit-Limit', String(limit));
    c.res.headers.set('X-RateLimit-Remaining', String(remaining));
    c.res.headers.set('X-RateLimit-Reset', String(reset));

    if (count > limit) {
      c.res.headers.set('Retry-After', String(Math.ceil((resetAt - Date.now()) / 1000)));
      return c.json(
        {
          error: {
            code: 'RATE_LIMIT_EXCEEDED',
            message: 'Too many requests. Please retry after the rate limit window resets.',
          },
        },
        429
      );
    }

    await next();
  };
}
