import type { OpenAPIHono } from '@hono/zod-openapi';
import { createRoute } from '@hono/zod-openapi';
import { z } from 'zod';

import type { GovernanceLogUseCase } from '../../application/usecases/governance-log.js';
import { ErrorResponseSchema } from '../../contracts/error.js';
import type { AppEnv } from '../server.js';

const getGovernanceLogStateRoute = createRoute({
  method: 'get',
  path: '/v1/governance-log',
  responses: {
    200: { content: { 'application/json': { schema: z.any() } }, description: 'Governance log state' },
  },
});

const getGovernanceLogProofRoute = createRoute({
  method: 'get',
  path: '/v1/governance-log/proofs/{leafIndex}',
  request: { params: z.object({ leafIndex: z.string() }) },
  responses: {
    200: { content: { 'application/json': { schema: z.any() } }, description: 'Governance log proof' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid leaf index' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Leaf not found' },
  },
});

const replayGovernanceLogRoute = createRoute({
  method: 'get',
  path: '/v1/governance-log/replay',
  responses: {
    200: { content: { 'application/json': { schema: z.any() } }, description: 'Governance log replay' },
  },
});

export function registerGovernanceLogRoutes(
  app: OpenAPIHono<AppEnv>,
  deps: {
    governanceLog: GovernanceLogUseCase;
  },
) {
  app.openapi(getGovernanceLogStateRoute, async (c) => {
    return c.json(await deps.governanceLog.getState(), 200);
  });

  app.openapi(getGovernanceLogProofRoute, async (c) => {
    const raw = c.req.param('leafIndex');
    const leafIndex = Number(raw);
    if (!Number.isInteger(leafIndex) || leafIndex < 0) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid leaf index.' } }, 400);
    }
    const proof = await deps.governanceLog.getProof({ leaf_index: leafIndex });
    if (!proof) {
      return c.json({ error: { code: 'GOVERNANCE_LOG_LEAF_NOT_FOUND', message: 'Governance log leaf not found.' } }, 404);
    }
    return c.json(proof, 200);
  });

  app.openapi(replayGovernanceLogRoute, async (c) => {
    return c.json(await deps.governanceLog.replay(), 200);
  });
}
