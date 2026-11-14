import '../infrastructure/telemetry/instrumentation.js';

import { serve } from '@hono/node-server';

import { loadEnv } from '../infrastructure/config/env.js';
import { logger } from '../infrastructure/logging/pino.js';
import { buildApp } from './server.js';
import { buildAppDependencies } from './dependencies.js';

const env = loadEnv();
const deps = buildAppDependencies(env);
await deps.ready();
const app = buildApp(deps);

serve({
  fetch: app.fetch,
  hostname: env.HOST,
  port: env.PORT,
});

logger.info({ host: env.HOST, port: env.PORT }, 'server started');

