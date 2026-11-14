import type { OpenAPIHono } from '@hono/zod-openapi';
import { createRoute } from '@hono/zod-openapi';
import { z } from 'zod';

import type { ReviewsUseCase } from '../../application/usecases/reviews.js';
import type { AppEnv } from '../server.js';

const listPendingReviewsRoute = createRoute({
  method: 'get',
  path: '/v1/reviews/pending',
  responses: {
    200: { content: { 'application/json': { schema: z.any() } }, description: 'Pending reviews' },
  },
});

export function registerReviewRoutes(
  app: OpenAPIHono<AppEnv>,
  deps: {
    reviews: ReviewsUseCase;
  },
) {
  app.openapi(listPendingReviewsRoute, async (c) => {
    return c.json(await deps.reviews.listPending(), 200);
  });
}
