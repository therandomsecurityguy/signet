import type { OpenAPIHono } from '@hono/zod-openapi';
import { createRoute } from '@hono/zod-openapi';

import { GraphSubgraphInputSchema, GraphSubgraphOutputSchema } from '../../contracts/graph/subgraph.js';
import { ErrorResponseSchema } from '../../contracts/error.js';
import type { ReadGraphSubgraphUseCase } from '../../application/usecases/read-graph-subgraph.js';
import type { AppEnv } from '../server.js';

const getGraphSubgraphRoute = createRoute({
  method: 'get',
  path: '/v1/graph/subgraph',
  request: { query: GraphSubgraphInputSchema },
  responses: {
    200: { content: { 'application/json': { schema: GraphSubgraphOutputSchema } }, description: 'Graph subgraph' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid graph query parameters' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Graph root not found' },
  },
});

export function registerGraphRoutes(
  app: OpenAPIHono<AppEnv>,
  deps: {
    readGraphSubgraph: ReadGraphSubgraphUseCase;
  },
) {
  app.openapi(getGraphSubgraphRoute, async (c) => {
    const parsed = GraphSubgraphInputSchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid graph query parameters.' } }, 400);
    }

    const subgraph = await deps.readGraphSubgraph.execute(parsed.data);
    if (!subgraph) {
      return c.json({ error: { code: 'GRAPH_ROOT_NOT_FOUND', message: 'Graph root not found.' } }, 404);
    }

    return c.json(subgraph, 200);
  });
}
