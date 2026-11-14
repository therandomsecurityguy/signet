import type { OpenAPIHono } from '@hono/zod-openapi';
import { createRoute } from '@hono/zod-openapi';
import { z } from 'zod';

import { ApiError } from '../../domain/errors/api-error.js';
import type { AuditPublisher } from '../../application/ports/audit-publisher.js';
import type { CreateSkillUseCase } from '../../application/usecases/create-skill.js';
import type { GetSkillUseCase } from '../../application/usecases/get-skill.js';
import type { ListSkillsUseCase } from '../../application/usecases/list-skills.js';
import { CreateSkillInputSchema, CreateSkillOutputSchema } from '../../contracts/skills/create-skill.js';
import { GetSkillInputSchema, GetSkillOutputSchema } from '../../contracts/skills/get-skill.js';
import { ListSkillsInputSchema, ListSkillsOutputSchema } from '../../contracts/skills/list-skills.js';
import { ErrorResponseSchema } from '../../contracts/error.js';
import type { AppEnv } from '../server.js';
import { auditApiWrite } from './audit.js';
import { entityKeySchema } from '../../contracts/keys.js';

const listSkillsRoute = createRoute({
  method: 'get',
  path: '/v1/skills',
  request: { query: ListSkillsInputSchema },
  responses: {
    200: { content: { 'application/json': { schema: ListSkillsOutputSchema } }, description: 'List skills' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid query parameters' },
  },
});

const getSkillRoute = createRoute({
  method: 'get',
  path: '/v1/skills/{skillKey}',
  request: { params: z.object({ skillKey: entityKeySchema }) },
  responses: {
    200: { content: { 'application/json': { schema: GetSkillOutputSchema } }, description: 'Get skill' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid skill key' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Skill not found' },
  },
});

const createSkillRoute = createRoute({
  method: 'post',
  path: '/v1/skills',
  request: { body: { content: { 'application/json': { schema: CreateSkillInputSchema } } } },
  responses: {
    200: { content: { 'application/json': { schema: CreateSkillOutputSchema } }, description: 'Skill already exists (idempotent)' },
    201: { content: { 'application/json': { schema: CreateSkillOutputSchema } }, description: 'Skill created' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid skill payload' },
    409: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Skill conflict' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Internal error' },
  },
});

export function registerSkillRoutes(
  app: OpenAPIHono<AppEnv>,
  deps: {
    listSkills: ListSkillsUseCase;
    getSkill: GetSkillUseCase;
    createSkill: CreateSkillUseCase;
    audit: AuditPublisher;
  },
) {
  app.openapi(listSkillsRoute, async (c) => {
    const query = c.req.valid('query');
    const body = await deps.listSkills.execute(query);
    return c.json(body, 200);
  });

  app.openapi(getSkillRoute, async (c) => {
    const { skillKey } = c.req.valid('param');
    const parsed = GetSkillInputSchema.safeParse({ skill_key: skillKey });
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid skill key.' } }, 400);
    }

    const got = await deps.getSkill.execute(parsed.data);
    if (!got) {
      return c.json({ error: { code: 'SKILL_NOT_FOUND', message: 'Skill not found.' } }, 404);
    }

    return c.json(got, 200);
  });

  app.openapi(createSkillRoute, async (c) => {
    const data = c.req.valid('json');
    const principal = c.get('principal');

    try {
      const created = await deps.createSkill.execute(data);
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

      c.get('logger').error({ err }, 'unhandled skill create error');
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
