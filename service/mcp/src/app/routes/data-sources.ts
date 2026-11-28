import type { Hono } from 'hono';

import type { ListDataSourcesUseCase } from '../../application/usecases/list-data-sources.js';
import type { AppEnv } from '../server.js';

export function registerDataSourceRoutes(
  app: Hono<AppEnv>,
  deps: { listDataSources: ListDataSourcesUseCase },
) {
  // Readiness for the approved data sources (mode + missing config presence).
  // Behind the same bearer auth as every /v1 route; reports booleans only.
  app.get('/v1/data-sources', async (c) => {
    return c.json(deps.listDataSources.execute(), 200);
  });
}
