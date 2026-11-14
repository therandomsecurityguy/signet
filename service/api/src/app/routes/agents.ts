import type { OpenAPIHono } from '@hono/zod-openapi';
import { createRoute } from '@hono/zod-openapi';
import { z } from 'zod';

import type { AuditPublisher } from '../../application/ports/audit-publisher.js';
import { CreateAgentInputSchema, CreateAgentOutputSchema } from '../../contracts/agents/create-agent.js';
import { GetAgentInputSchema, GetAgentOutputSchema } from '../../contracts/agents/get-agent.js';
import { ListAgentsInputSchema, ListAgentsOutputSchema } from '../../contracts/agents/list-agents.js';
import { ErrorResponseSchema } from '../../contracts/error.js';
import { ApiError } from '../../domain/errors/api-error.js';
import type { CreateAgentUseCase } from '../../application/usecases/create-agent.js';
import type { GetAgentUseCase } from '../../application/usecases/get-agent.js';
import type { ListAgentsUseCase } from '../../application/usecases/list-agents.js';
import type { AppEnv } from '../server.js';
import { auditApiWrite } from './audit.js';
import { entityKeySchema } from '../../contracts/keys.js';

const listAgentsRoute = createRoute({
  method: 'get',
  path: '/v1/agents',
  request: { query: ListAgentsInputSchema },
  responses: {
    200: { content: { 'application/json': { schema: ListAgentsOutputSchema } }, description: 'List agents' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid query parameters' },
  },
});

const getAgentRoute = createRoute({
  method: 'get',
  path: '/v1/agents/{agentKey}',
  request: { params: z.object({ agentKey: entityKeySchema }) },
  responses: {
    200: { content: { 'application/json': { schema: GetAgentOutputSchema } }, description: 'Get agent' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid agent key' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Agent not found' },
  },
});

const createAgentRoute = createRoute({
  method: 'post',
  path: '/v1/agents',
  request: { body: { content: { 'application/json': { schema: CreateAgentInputSchema } } } },
  responses: {
    200: { content: { 'application/json': { schema: CreateAgentOutputSchema } }, description: 'Agent already exists (idempotent)' },
    201: { content: { 'application/json': { schema: CreateAgentOutputSchema } }, description: 'Agent created' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid agent payload' },
    409: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Agent conflict' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Internal error' },
  },
});

export function registerAgentRoutes(
  app: OpenAPIHono<AppEnv>,
  deps: {
    listAgents: ListAgentsUseCase;
    getAgent: GetAgentUseCase;
    createAgent: CreateAgentUseCase;
    audit: AuditPublisher;
  },
) {
  app.openapi(listAgentsRoute, async (c) => {
    const query = c.req.valid('query');
    const body = await deps.listAgents.execute(query);
    return c.json(body, 200);
  });

  app.openapi(getAgentRoute, async (c) => {
    const { agentKey } = c.req.valid('param');
    const parsed = GetAgentInputSchema.safeParse({ agent_key: agentKey });
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid agent key.' } }, 400);
    }

    const got = await deps.getAgent.execute(parsed.data);
    if (!got) {
      return c.json({ error: { code: 'AGENT_NOT_FOUND', message: 'Agent not found.' } }, 404);
    }

    return c.json(got, 200);
  });

  app.openapi(createAgentRoute, async (c) => {
    const data = c.req.valid('json');
    const principal = c.get('principal');

    try {
      const created = await deps.createAgent.execute(data);
      if (principal) {
        await auditApiWrite({
          audit: deps.audit,
          request_id: c.get('requestId'),
          client_name: c.req.header('X-Agent-Client') ?? 'unknown',
          principal,
          path: c.req.path,
          method: 'POST',
          raw_input: data,
          policy_effect: 'allow',
          policy_reason: created.created ? 'created' : 'idempotent',
        });
      }
      return c.json(created.value, created.created ? 201 : 200);
    } catch (err) {
      if (err instanceof ApiError) {
        if (principal) {
          await auditApiWrite({
            audit: deps.audit,
            request_id: c.get('requestId'),
            client_name: c.req.header('X-Agent-Client') ?? 'unknown',
            principal,
            path: c.req.path,
            method: 'POST',
            raw_input: data,
            policy_effect: 'deny',
            policy_reason: err.code,
            error_code: err.code,
          });
        }
return c.json(
          { error: { code: err.code, message: err.message } },
          err.httpStatus as 400 | 404 | 409 | 500,
        ) as never;
      }

      c.get('logger').error({ err }, 'unhandled agent create error');
      if (principal) {
        await auditApiWrite({
          audit: deps.audit,
          request_id: c.get('requestId'),
          client_name: c.req.header('X-Agent-Client') ?? 'unknown',
          principal,
          path: c.req.path,
          method: 'POST',
          raw_input: data,
          policy_effect: 'deny',
          policy_reason: 'internal_error',
          error_code: 'INTERNAL_ERROR',
        });
      }
      return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Internal error.' } }, 500);
    }
  });
}
