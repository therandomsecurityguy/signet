import type { OpenAPIHono } from '@hono/zod-openapi';
import { createRoute } from '@hono/zod-openapi';

import type { SearchRegistryUseCase } from '../../application/usecases/search-registry.js';
import {
  SearchRegistryInputSchema,
  SearchRegistryOutputSchema,
} from '../../contracts/search/search-registry.js';
import { ErrorResponseSchema } from '../../contracts/error.js';
import type { AppEnv } from '../server.js';

const searchRegistryRoute = createRoute({
  method: 'get',
  path: '/v1/search',
  request: { query: SearchRegistryInputSchema },
  responses: {
    200: { content: { 'application/json': { schema: SearchRegistryOutputSchema } }, description: 'Search the registry' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid query parameters' },
  },
});

export function registerSearchRoutes(
  app: OpenAPIHono<AppEnv>,
  deps: { search: SearchRegistryUseCase },
) {
  app.openapi(searchRegistryRoute, async (c) => {
    const query = c.req.valid('query');
    return c.json(await deps.search.execute(query), 200);
  });
}
