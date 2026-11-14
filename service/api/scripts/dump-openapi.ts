import { writeFile } from 'node:fs/promises';

import { buildAppDependencies } from '../src/app/dependencies.js';
import { buildApp } from '../src/app/server.js';
import { loadEnv } from '../src/infrastructure/config/env.js';

const outPath = process.argv[2] ?? 'openapi.json';

const env = loadEnv({
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL: ':memory:',
  REGISTRY_GRAPH_BACKEND: 'memory',
});
const deps = buildAppDependencies(env);
await deps.ready();
const app = buildApp(deps);

const res = await app.request('/v1/openapi.json');
if (!res.ok) {
  throw new Error(`Failed to fetch OpenAPI spec: ${res.status}`);
}
const spec = await res.json();
await writeFile(outPath, JSON.stringify(spec, null, 2));
console.log(`wrote OpenAPI spec to ${outPath}`);
