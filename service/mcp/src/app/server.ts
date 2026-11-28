import { timingSafeEqual } from 'node:crypto';

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { requestId } from 'hono/request-id';

import { logger as baseLogger } from '../infrastructure/logging/pino.js';
import { makeRequestLogger } from '../infrastructure/logging/request-logger.js';
import {
  httpRequestDurationSeconds,
  httpRequestsTotal,
  registry,
} from '../infrastructure/telemetry/metrics.js';
import { registerToolRoutes } from './routes/tools.js';
import { registerDataSourceRoutes } from './routes/data-sources.js';
import type { Principal } from '../domain/principal/principal.js';
import type { AppDependencies } from './dependencies.js';
import { registerMcpRoutes } from './routes/mcp.js';
import { buildAuthMiddleware } from './middleware/auth.js';
import { buildRateLimitMiddleware } from './middleware/rate-limit.js';
import { registerOAuthMetadataRoutes } from './routes/oauth-metadata.js';

const SECURITY_HEADERS = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'X-XSS-Protection': '1; mode=block',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; object-src 'none'",
};

export type AppEnv = {
  Variables: {
    requestId: string;
    logger: ReturnType<typeof makeRequestLogger>;
    principal?: Principal;
  };
};

function metricsAuthorized(expectedToken: string | undefined, header: string | undefined): boolean {
  if (!expectedToken) return true;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : (header ?? '');
  const provided = Buffer.from(token);
  const expected = Buffer.from(expectedToken);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export function buildApp(deps: AppDependencies) {
  const app = new Hono<AppEnv>();

  app.use('*', requestId());
  app.use('*', cors({
    origin: deps.env.CORS_ALLOWED_ORIGINS
      ? deps.env.CORS_ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
      : '*',
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-Agent-Client'],
  }));
  app.use('*', buildRateLimitMiddleware(deps.env));

  app.use('*', async (c, next) => {
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
      c.res.headers.set(key, value);
    }
    await next();
  });

  app.use('*', async (c, next) => {
    const requestIdValue = c.get('requestId');
    const clientName = c.req.header('X-Agent-Client') ?? 'unknown';
    const requestLogger = makeRequestLogger(baseLogger, {
      requestId: requestIdValue,
      clientName,
    });
    c.set('logger', requestLogger);
    await next();
  });

  app.use('*', async (c, next) => {
    const start = Date.now();
    await next();
    const route = c.req.routePath ?? c.req.path;
    const labels = {
      method: c.req.method,
      route,
      status: String(c.res.status),
    };
    httpRequestsTotal.inc(labels);
    httpRequestDurationSeconds.observe(labels, (Date.now() - start) / 1000);
  });

  app.get('/healthz', (c) => c.json({ ok: true }));
  app.get('/readyz', (c) => c.json({ ok: true }));
  app.get('/metrics', async (c) => {
    if (!metricsAuthorized(deps.env.METRICS_AUTH_TOKEN, c.req.header('authorization'))) {
      return c.json({ error: { code: 'AUTH_UNAUTHENTICATED', message: 'Unauthorized.' } }, 401);
    }
    c.header('content-type', registry.contentType);
    return c.body(await registry.metrics());
  });
  registerOAuthMetadataRoutes(app, deps.env);

  const auth = buildAuthMiddleware({ env: deps.env, apiKeys: deps.apiKeys, audit: deps.audit });
  app.use('/mcp', auth);
  app.use('/v1/*', auth);

  registerToolRoutes(app, {
    listTools: deps.listTools,
    executeTool: deps.executeTool,
  });

  registerDataSourceRoutes(app, {
    listDataSources: deps.listDataSources,
  });

  registerMcpRoutes(app, {
    registry: deps.registry,
    executeTool: deps.executeTool,
  });

  return app;
}

