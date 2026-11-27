import type { OpenAPIHono } from '@hono/zod-openapi';
import { createRoute } from '@hono/zod-openapi';

import type { RegistryService } from '../../../../registry/application/ports/registry-service.js';
import { UsageSignalOutputSchema, UsageSignalQuerySchema } from '../../contracts/usage.js';
import { ErrorResponseSchema } from '../../contracts/error.js';
import type { AppEnv } from '../server.js';

const getUsageSignalRoute = createRoute({
  method: 'get',
  path: '/v1/usage-signals',
  request: { query: UsageSignalQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: UsageSignalOutputSchema } },
      description: 'Aggregate usage signal for one publication or artifact (null when none recorded)',
    },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid usage query parameters' },
  },
});

// Read-only aggregate usage counts (build plan 3.1). Exactly one target per
// request; no identities are ever returned because none are stored.
export function registerUsageRoutes(app: OpenAPIHono<AppEnv>, deps: { registry: RegistryService }) {
  app.openapi(getUsageSignalRoute, async (c) => {
    const parsed = UsageSignalQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid usage query parameters.' } }, 400);
    }
    const publicationUrn = parsed.data.publication_urn;
    const artifactSha = parsed.data.artifact_sha256;
    if ((publicationUrn ? 1 : 0) + (artifactSha ? 1 : 0) !== 1) {
      return c.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Provide exactly one of publication_urn or artifact_sha256.',
          },
        },
        400,
      );
    }
    const usage = await deps.registry.getUsageSignal({
      ...(publicationUrn ? { publication_urn: publicationUrn } : {}),
      ...(artifactSha ? { artifact_sha256: artifactSha } : {}),
    });
    return c.json({ usage }, 200);
  });
}
