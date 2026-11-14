import { serve } from '@hono/node-server';

import { buildApp } from './app.js';
import { loadEnv } from './config/env.js';

const env = loadEnv();
const app = buildApp(env);

serve(
  {
    fetch: app.fetch,
    hostname: env.HOST,
    port: env.PORT,
  },
  (info) => {
    console.log(
      JSON.stringify(
        {
          service: 'tessera-sidecar',
          listening_on: `http://${env.HOST}:${info.port}`,
          bucket: env.TESSERA_SIDECAR_BUCKET,
          requests_prefix: env.TESSERA_SIDECAR_REQUESTS_PREFIX,
        },
        null,
        2,
      ),
    );
  },
);
