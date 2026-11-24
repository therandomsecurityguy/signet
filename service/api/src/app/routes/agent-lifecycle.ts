import type { Context } from 'hono';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { createRoute } from '@hono/zod-openapi';
import { z } from 'zod';

import type { AuditPublisher } from '../../application/ports/audit-publisher.js';
import type { AgentLifecycleUseCase } from '../../application/usecases/agent-lifecycle.js';
import { ApiError } from '../../domain/errors/api-error.js';
import { RegistryCoreError } from '../../../../registry/application/errors/registry-core-error.js';
import { logger } from '../../infrastructure/logging/pino.js';
import { AgentVersionOperationInputSchema, CreateAgentDraftInputSchema } from '../../contracts/agents/lifecycle.js';
import { PreparedPublicationSchema } from '../../contracts/publication/envelope.js';
import { ReviewVersionInputSchema } from '../../contracts/skills/lifecycle.js';
import { ErrorResponseSchema } from '../../contracts/error.js';
import type { AppEnv } from '../server.js';
import { auditApiWrite } from './audit.js';
import { entityKeySchema } from '../../contracts/keys.js';

const createAgentDraftRoute = createRoute({
  method: 'post',
  path: '/v1/agents/{agentKey}/drafts',
  request: {
    params: z.object({ agentKey: entityKeySchema }),
    body: { content: { 'application/json': { schema: CreateAgentDraftInputSchema } } },
  },
  responses: {
    200: { content: { 'application/json': { schema: z.any() } }, description: 'Agent draft created' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid agent draft payload' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Agent not found' },
    409: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Agent conflict' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Internal error' },
  },
});

const validateAgentVersionRoute = createRoute({
  method: 'post',
  path: '/v1/agents/{agentKey}/versions/{version}/validate',
  request: {
    params: z.object({ agentKey: entityKeySchema, version: z.string() }),
    body: { content: { 'application/json': { schema: AgentVersionOperationInputSchema } } },
  },
  responses: {
    200: { content: { 'application/json': { schema: z.any() } }, description: 'Agent version validated' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid agent version operation payload' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Agent version not found' },
    409: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Agent version conflict' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Internal error' },
  },
});

const publishAgentVersionRoute = createRoute({
  method: 'post',
  path: '/v1/agents/{agentKey}/versions/{version}/publish',
  request: {
    params: z.object({ agentKey: entityKeySchema, version: z.string() }),
    body: { content: { 'application/json': { schema: AgentVersionOperationInputSchema } } },
  },
  responses: {
    200: { content: { 'application/json': { schema: z.any() } }, description: 'Agent version published' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid agent version operation payload' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Agent version not found' },
    409: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Agent version conflict' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Internal error' },
  },
});

const prepareAgentPublicationRoute = createRoute({
  method: 'post',
  path: '/v1/agents/{agentKey}/versions/{version}/prepare-publication',
  request: {
    params: z.object({ agentKey: entityKeySchema, version: z.string() }),
    body: { content: { 'application/json': { schema: AgentVersionOperationInputSchema } } },
  },
  responses: {
    200: { content: { 'application/json': { schema: PreparedPublicationSchema } }, description: 'Publication candidate prepared for signing' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid agent version operation payload' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Agent version not found' },
    409: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Agent version conflict' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Internal error' },
  },
});

const promoteAgentVersionRoute = createRoute({
  method: 'post',
  path: '/v1/agents/{agentKey}/versions/{version}/promote',
  request: {
    params: z.object({ agentKey: entityKeySchema, version: z.string() }),
    body: { content: { 'application/json': { schema: AgentVersionOperationInputSchema } } },
  },
  responses: {
    200: { content: { 'application/json': { schema: z.any() } }, description: 'Agent version promoted' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid agent version operation payload' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Agent version not found' },
    409: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Agent version conflict' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Internal error' },
  },
});

const deprecateAgentVersionRoute = createRoute({
  method: 'post',
  path: '/v1/agents/{agentKey}/versions/{version}/deprecate',
  request: {
    params: z.object({ agentKey: entityKeySchema, version: z.string() }),
    body: { content: { 'application/json': { schema: AgentVersionOperationInputSchema } } },
  },
  responses: {
    200: { content: { 'application/json': { schema: z.any() } }, description: 'Agent version deprecated' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid agent version operation payload' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Agent version not found' },
    409: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Agent version conflict' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Internal error' },
  },
});

const certifyAgentVersionRoute = createRoute({
  method: 'post',
  path: '/v1/agents/{agentKey}/versions/{version}/certify',
  request: {
    params: z.object({ agentKey: entityKeySchema, version: z.string() }),
    body: { content: { 'application/json': { schema: AgentVersionOperationInputSchema } } },
  },
  responses: {
    200: { content: { 'application/json': { schema: z.any() } }, description: 'Agent version certified' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid agent version operation payload' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Agent version not found' },
    409: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Agent version conflict' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Internal error' },
  },
});

const revokeAgentVersionRoute = createRoute({
  method: 'post',
  path: '/v1/agents/{agentKey}/versions/{version}/revoke',
  request: {
    params: z.object({ agentKey: entityKeySchema, version: z.string() }),
    body: { content: { 'application/json': { schema: AgentVersionOperationInputSchema } } },
  },
  responses: {
    200: { content: { 'application/json': { schema: z.any() } }, description: 'Agent version revoked' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid agent version operation payload' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Agent version not found' },
    409: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Agent version conflict' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Internal error' },
  },
});

const archiveAgentVersionRoute = createRoute({
  method: 'post',
  path: '/v1/agents/{agentKey}/versions/{version}/archive',
  request: {
    params: z.object({ agentKey: entityKeySchema, version: z.string() }),
    body: { content: { 'application/json': { schema: AgentVersionOperationInputSchema } } },
  },
  responses: {
    200: { content: { 'application/json': { schema: z.any() } }, description: 'Agent version archived' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid agent version operation payload' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Agent version not found' },
    409: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Agent version conflict' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Internal error' },
  },
});

const reviewAgentVersionRoute = createRoute({
  method: 'post',
  path: '/v1/agents/{agentKey}/versions/{version}/review',
  request: {
    params: z.object({ agentKey: entityKeySchema, version: z.string() }),
    body: { content: { 'application/json': { schema: ReviewVersionInputSchema } } },
  },
  responses: {
    200: { content: { 'application/json': { schema: z.any() } }, description: 'Agent version reviewed' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid review payload' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Agent version not found' },
    409: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Agent version conflict' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Internal error' },
  },
});

export function registerAgentLifecycleRoutes(
  app: OpenAPIHono<AppEnv>,
  deps: {
    lifecycle: AgentLifecycleUseCase;
    audit: AuditPublisher;
  },
) {
  app.openapi(createAgentDraftRoute, async (c) => {
    const raw = await c.req.json().catch(() => undefined);
    const parsed = CreateAgentDraftInputSchema.safeParse(raw);
    const agentKey = c.req.param('agentKey');
    return await handleLifecycleWrite({
      c,
      deps,
      raw,
      parsedSuccess: parsed.success && Boolean(agentKey),
      parsedData: parsed.success && agentKey ? { agent_key: agentKey, ...parsed.data } : undefined,
      action: async (data) => await deps.lifecycle.createDraft(data),
      validationMessage: 'Invalid agent draft payload.',
      method: 'POST',
    });
  });

  app.openapi(validateAgentVersionRoute, async (c) => {
    return await handleVersionAction({ c, deps, action: 'validate' });
  });

  app.openapi(publishAgentVersionRoute, async (c) => {
    return await handleVersionAction({ c, deps, action: 'publish' });
  });

  app.openapi(prepareAgentPublicationRoute, async (c) => {
    const raw = await c.req.json().catch(() => undefined);
    const parsed = AgentVersionOperationInputSchema.safeParse(raw);
    const rawVersion = c.req.param('version');
    const version = rawVersion ? parseVersion(rawVersion) : null;
    const agentKey = c.req.param('agentKey');
    return await handleLifecycleWrite({
      c,
      deps,
      raw,
      parsedSuccess: parsed.success && Boolean(version) && Boolean(agentKey),
      parsedData:
        parsed.success && version && agentKey
          ? { agent_key: agentKey, version, ...parsed.data }
          : undefined,
      action: async (data) => await deps.lifecycle.preparePublication(data),
      validationMessage: 'Invalid agent version operation payload.',
      method: 'POST',
    });
  });

  app.openapi(promoteAgentVersionRoute, async (c) => {
    return await handleVersionAction({ c, deps, action: 'promote' });
  });

  app.openapi(deprecateAgentVersionRoute, async (c) => {
    return await handleVersionAction({ c, deps, action: 'deprecate' });
  });

  app.openapi(certifyAgentVersionRoute, async (c) => {
    return await handleVersionAction({ c, deps, action: 'certify' });
  });

  app.openapi(revokeAgentVersionRoute, async (c) => {
    return await handleVersionAction({ c, deps, action: 'revoke' });
  });

  app.openapi(archiveAgentVersionRoute, async (c) => {
    return await handleVersionAction({ c, deps, action: 'archive' });
  });

  app.openapi(reviewAgentVersionRoute, async (c) => {
    const raw = await c.req.json().catch(() => undefined);
    const parsed = ReviewVersionInputSchema.safeParse(raw);
    const rawVersion = c.req.param('version');
    const version = rawVersion ? parseVersion(rawVersion) : null;
    const agentKey = c.req.param('agentKey');
    return await handleLifecycleWrite({
      c,
      deps,
      raw,
      parsedSuccess: parsed.success && Boolean(version) && Boolean(agentKey),
      parsedData:
        parsed.success && version && agentKey
          ? { agent_key: agentKey, version, ...parsed.data }
          : undefined,
      action: async (data) => await deps.lifecycle.review(data),
      validationMessage: 'Invalid review payload.',
      method: 'POST',
    });
  });
}

async function handleVersionAction(input: {
  c: Context<AppEnv>;
  deps: { lifecycle: AgentLifecycleUseCase; audit: AuditPublisher };
  action: 'validate' | 'publish' | 'promote' | 'deprecate' | 'certify' | 'revoke' | 'archive';
}) {
  const raw = await input.c.req.json().catch(() => undefined);
  const parsed = AgentVersionOperationInputSchema.safeParse(raw);
  const rawVersion = input.c.req.param('version');
  const version = rawVersion ? parseVersion(rawVersion) : null;
  const agentKey = input.c.req.param('agentKey');

  return await handleLifecycleWrite({
    c: input.c,
    deps: input.deps,
    raw,
    parsedSuccess: parsed.success && Boolean(version) && Boolean(agentKey),
    parsedData:
      parsed.success && version && agentKey
        ? { agent_key: agentKey, version, ...parsed.data }
        : undefined,
    action: async (data) => await input.deps.lifecycle[input.action](data),
    validationMessage: 'Invalid agent version operation payload.',
    method: 'POST',
  });
}

async function handleLifecycleWrite<TInput extends Record<string, unknown>, TResult>(input: {
  c: Context<AppEnv>;
  deps: { lifecycle: AgentLifecycleUseCase; audit: AuditPublisher };
  raw: unknown;
  parsedSuccess: boolean;
  parsedData: TInput | undefined;
  action: (data: TInput) => Promise<TResult>;
  validationMessage: string;
  method: 'POST';
}) {
  const principal = input.c.get('principal');
  if (!input.parsedSuccess || !input.parsedData) {
    if (principal) {
      await auditApiWrite({
        audit: input.deps.audit,
        request_id: input.c.get('requestId'),
        client_name: input.c.req.header('X-Agent-Client') ?? 'unknown',
        principal,
        path: input.c.req.path,
        method: input.method,
        raw_input: input.raw,
        policy_effect: 'deny',
        policy_reason: 'validation_error',
        error_code: 'VALIDATION_ERROR',
      });
    }
    return input.c.json({ error: { code: 'VALIDATION_ERROR', message: input.validationMessage } }, 400);
  }

  try {
    const result = await input.action(input.parsedData);
    if (principal) {
      await auditApiWrite({
        audit: input.deps.audit,
        request_id: input.c.get('requestId'),
        client_name: input.c.req.header('X-Agent-Client') ?? 'unknown',
        principal,
        path: input.c.req.path,
        method: input.method,
        raw_input: input.parsedData,
        policy_effect: 'allow',
        policy_reason: 'operation_completed',
      });
    }
    return input.c.json(result, 200);
  } catch (err) {
    if (!(err instanceof RegistryCoreError)) {
      // Unknown errors would otherwise be mapped to a silent INTERNAL_ERROR;
      // log the stack so 500s are diagnosable.
      logger.error({ err, path: input.c.req.path }, 'unhandled agent lifecycle error');
    }
    const mapped = mapLifecycleError(err);
    if (principal) {
      await auditApiWrite({
        audit: input.deps.audit,
        request_id: input.c.get('requestId'),
        client_name: input.c.req.header('X-Agent-Client') ?? 'unknown',
        principal,
        path: input.c.req.path,
        method: input.method,
        raw_input: input.parsedData,
        policy_effect: 'deny',
        policy_reason: mapped.code,
        error_code: mapped.code,
      });
    }
    return input.c.json({ error: { code: mapped.code, message: mapped.message } }, mapped.httpStatus as 400 | 404 | 409 | 500);
  }
}

function parseVersion(raw: string): number | null {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function mapLifecycleError(err: unknown) {
  if (err instanceof RegistryCoreError) {
    switch (err.code) {
      case 'AGENT_VERSION_NOT_FOUND':
      case 'SKILL_NOT_FOUND':
        return new ApiError(err.code, 404, err.message);
      case 'ONTOLOGY_PACKAGE_NOT_FOUND':
        return new ApiError(err.code, 404, err.message);
      case 'AGENT_VERSION_CREATE_FAILED':
        return new ApiError(err.code, 500, err.message);
      default:
        if (err.code.startsWith('AGENT_VERSION_') || err.code.startsWith('AGENT_PUBLISH_')) {
          return new ApiError(err.code, 409, err.message);
        }
        return new ApiError(err.code, 500, err.message);
    }
  }
  if (err instanceof ApiError) return err;
  return new ApiError('INTERNAL_ERROR', 500, 'Internal error.');
}
