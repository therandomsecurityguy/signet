import { serve } from '@hono/node-server';

import { buildApp } from './app.js';
import { loadEnv } from './config/env.js';
import { logger } from './logging/pino.js';
import { HttpRegistryApiClient } from './clients/registry-api.js';
import { HttpSemanticTurkeyClient } from './clients/semantic-turkey.js';
import { SqliteOperatorSessionStore } from './session-store.js';

const env = loadEnv();
const sessionStore = await SqliteOperatorSessionStore.create({
  databaseUrl: env.DATABASE_URL,
  ttlMinutes: env.SESSION_TTL_MINUTES,
});

const app = buildApp({
  env,
  registryApi: new HttpRegistryApiClient({ apiOrigin: env.API_ORIGIN }),
  semanticTurkey: new HttpSemanticTurkeyClient({
    ...(env.SEMANTIC_TURKEY_BASE_URL ? { baseUrl: env.SEMANTIC_TURKEY_BASE_URL } : {}),
    ...(env.SEMANTIC_TURKEY_EMAIL ? { email: env.SEMANTIC_TURKEY_EMAIL } : {}),
    ...(env.SEMANTIC_TURKEY_PASSWORD ? { password: env.SEMANTIC_TURKEY_PASSWORD } : {}),
  }),
  sessionStore,
});

serve(
  {
    fetch: app.fetch,
    hostname: env.HOST,
    port: env.PORT,
  },
  (info) => {
    logger.info({ port: info.port }, 'knowledge-manager listening');
  },
);
