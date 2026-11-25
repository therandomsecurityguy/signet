import type { OpenAPIHono } from '@hono/zod-openapi';
import { createRoute } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { z } from 'zod';

import type { AuditPublisher } from '../../application/ports/audit-publisher.js';
import type { SetTagsUseCase } from '../../application/usecases/set-tags.js';
import { ErrorResponseSchema } from '../../contracts/error.js';
import { entityKeySchema } from '../../contracts/keys.js';
import {
  SetAgentTagsOutputSchema,
  SetSkillTagsOutputSchema,
  SetTagsInputSchema,
} from '../../contracts/tags.js';
import { ApiError } from '../../domain/errors/api-error.js';
import type { AppEnv } from '../server.js';
import { auditApiWrite } from './audit.js';

const setSkillTagsRoute = createRoute({
  method: 'put',
  path: '/v1/skills/{skillKey}/tags',
  request: {
    params: z.object({ skillKey: entityKeySchema }),
    body: { content: { 'application/json': { schema: SetTagsInputSchema } } },
  },
  responses: {
    200: { content: { 'application/json': { schema: SetSkillTagsOutputSchema } }, description: 'Skill tags updated' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid tags' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Skill not found' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Internal error' },
  },
});

const setAgentTagsRoute = createRoute({
  method: 'put',
  path: '/v1/agents/{agentKey}/tags',
  request: {
    params: z.object({ agentKey: entityKeySchema }),
    body: { content: { 'application/json': { schema: SetTagsInputSchema } } },
  },
  responses: {
    200: { content: { 'application/json': { schema: SetAgentTagsOutputSchema } }, description: 'Agent tags updated' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid tags' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Agent not found' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Internal error' },
  },
});

interface TagDeps {
  tags: SetTagsUseCase;
  audit: AuditPublisher;
}

async function applyTags(
  c: Context<AppEnv>,
  deps: TagDeps,
  input: { entity_type: 'SKILL' | 'AGENT'; logical_key: string; body: { tags: string[] } },
): Promise<{ tags: string[] }> {
  const principal = c.get('principal');
  try {
    const result = await deps.tags.execute({
      entity_type: input.entity_type,
      logical_key: input.logical_key,
      tags: input.body.tags,
    });
    if (principal) {
      await auditApiWrite({
        audit: deps.audit,
        request_id: c.get('requestId'),
        client_name: c.req.header('X-Agent-Client') ?? 'unknown',
        principal,
        path: c.req.path,
        method: 'PUT',
        raw_input: input.body,
        policy_effect: 'allow',
        policy_reason: 'tags_updated',
      });
    }
    return result;
  } catch (err) {
    const mapped = err instanceof ApiError ? err : new ApiError('INTERNAL_ERROR', 500, 'Internal error.');
    if (principal) {
      await auditApiWrite({
        audit: deps.audit,
        request_id: c.get('requestId'),
        client_name: c.req.header('X-Agent-Client') ?? 'unknown',
        principal,
        path: c.req.path,
        method: 'PUT',
        raw_input: input.body,
        policy_effect: 'deny',
        policy_reason: mapped.code,
        error_code: mapped.code,
      });
    }
    throw mapped;
  }
}

export function registerTagRoutes(app: OpenAPIHono<AppEnv>, deps: TagDeps) {
  app.openapi(setSkillTagsRoute, async (c) => {
    const { skillKey } = c.req.valid('param');
    const body = c.req.valid('json');
    try {
      const result = await applyTags(c, deps, { entity_type: 'SKILL', logical_key: skillKey, body });
      return c.json({ skill_key: skillKey, tags: result.tags }, 200);
    } catch (err) {
      const mapped = err instanceof ApiError ? err : new ApiError('INTERNAL_ERROR', 500, 'Internal error.');
      return c.json({ error: { code: mapped.code, message: mapped.message } }, mapped.httpStatus as 400 | 404 | 500);
    }
  });

  app.openapi(setAgentTagsRoute, async (c) => {
    const { agentKey } = c.req.valid('param');
    const body = c.req.valid('json');
    try {
      const result = await applyTags(c, deps, { entity_type: 'AGENT', logical_key: agentKey, body });
      return c.json({ agent_key: agentKey, tags: result.tags }, 200);
    } catch (err) {
      const mapped = err instanceof ApiError ? err : new ApiError('INTERNAL_ERROR', 500, 'Internal error.');
      return c.json({ error: { code: mapped.code, message: mapped.message } }, mapped.httpStatus as 400 | 404 | 500);
    }
  });
}
