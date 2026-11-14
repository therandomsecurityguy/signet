import type { OpenAPIHono } from '@hono/zod-openapi';
import { createRoute } from '@hono/zod-openapi';
import { z } from 'zod';

import type { AuditPublisher } from '../../application/ports/audit-publisher.js';
import type { ApiKeyUseCase } from '../../application/usecases/api-keys.js';
import {
  CreateApiKeyInputSchema,
  CreateApiKeyOutputSchema,
  ListApiKeysOutputSchema,
  RevokeApiKeyOutputSchema,
  RotateApiKeyOutputSchema,
} from '../../contracts/api-keys.js';
import { ErrorResponseSchema } from '../../contracts/error.js';
import type { AppEnv } from '../server.js';
import { auditApiWrite } from './audit.js';

const listApiKeysRoute = createRoute({
  method: 'get',
  path: '/v1/api-keys',
  responses: {
    200: { content: { 'application/json': { schema: ListApiKeysOutputSchema } }, description: 'List API keys (metadata only)' },
    403: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Admin access required' },
  },
});

const createApiKeyRoute = createRoute({
  method: 'post',
  path: '/v1/api-keys',
  request: { body: { content: { 'application/json': { schema: CreateApiKeyInputSchema } } } },
  responses: {
    201: { content: { 'application/json': { schema: CreateApiKeyOutputSchema } }, description: 'API key created (secret returned once)' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid request' },
    403: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Admin access required' },
  },
});

const revokeApiKeyRoute = createRoute({
  method: 'delete',
  path: '/v1/api-keys/{keyId}',
  request: { params: z.object({ keyId: z.string().min(1) }) },
  responses: {
    200: { content: { 'application/json': { schema: RevokeApiKeyOutputSchema } }, description: 'API key revoked' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'API key not found' },
    403: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Admin access required' },
  },
});

const rotateApiKeyRoute = createRoute({
  method: 'post',
  path: '/v1/api-keys/{keyId}/rotate',
  request: { params: z.object({ keyId: z.string().min(1) }) },
  responses: {
    200: { content: { 'application/json': { schema: RotateApiKeyOutputSchema } }, description: 'API key rotated (new secret returned once)' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'API key not found or revoked' },
    403: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Admin access required' },
  },
});

export function registerApiKeyRoutes(
  app: OpenAPIHono<AppEnv>,
  deps: { apiKeys: ApiKeyUseCase; audit: AuditPublisher },
) {
  app.openapi(listApiKeysRoute, async (c) => {
    const api_keys = await deps.apiKeys.list();
    return c.json({ api_keys }, 200);
  });

  app.openapi(createApiKeyRoute, async (c) => {
    const raw = await c.req.json().catch(() => undefined);
    const parsed = CreateApiKeyInputSchema.safeParse(raw);
    const principal = c.get('principal');
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid API key request.' } }, 400);
    }
    try {
      const created = await deps.apiKeys.create({
        owner_label: parsed.data.owner_label,
        ...(parsed.data.scopes ? { scopes: parsed.data.scopes } : {}),
        ...(typeof parsed.data.ttl_days === 'number' ? { ttl_days: parsed.data.ttl_days } : {}),
        created_by: principal?.id ?? null,
      });
      if (principal) {
        await auditApiWrite({
          audit: deps.audit,
          request_id: c.get('requestId'),
          client_name: c.req.header('X-Agent-Client') ?? 'unknown',
          principal,
          path: c.req.path,
          method: 'POST',
          raw_input: { owner_label: parsed.data.owner_label, scopes: created.metadata.scopes },
          policy_effect: 'allow',
          policy_reason: 'api_key_created',
        });
      }
      return c.json({ token: created.token, api_key: created.metadata }, 201);
    } catch (err) {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: err instanceof Error ? err.message : 'Invalid API key request.' } },
        400,
      );
    }
  });

  app.openapi(revokeApiKeyRoute, async (c) => {
    const { keyId } = c.req.valid('param');
    const existing = await deps.apiKeys.list().then((keys) => keys.find((k) => k.key_id === keyId));
    if (!existing) {
      return c.json({ error: { code: 'API_KEY_NOT_FOUND', message: 'API key not found.' } }, 404);
    }
    await deps.apiKeys.revoke(keyId);
    const principal = c.get('principal');
    if (principal) {
      await auditApiWrite({
        audit: deps.audit,
        request_id: c.get('requestId'),
        client_name: c.req.header('X-Agent-Client') ?? 'unknown',
        principal,
        path: c.req.path,
        method: 'DELETE',
        raw_input: { key_id: keyId },
        policy_effect: 'allow',
        policy_reason: 'api_key_revoked',
      });
    }
    return c.json({ api_key: { ...existing, revoked_at: existing.revoked_at ?? new Date().toISOString() } }, 200);
  });

  app.openapi(rotateApiKeyRoute, async (c) => {
    const { keyId } = c.req.valid('param');
    const rotated = await deps.apiKeys.rotate(keyId);
    if (!rotated) {
      return c.json({ error: { code: 'API_KEY_NOT_FOUND', message: 'API key not found or revoked.' } }, 404);
    }
    const principal = c.get('principal');
    if (principal) {
      await auditApiWrite({
        audit: deps.audit,
        request_id: c.get('requestId'),
        client_name: c.req.header('X-Agent-Client') ?? 'unknown',
        principal,
        path: c.req.path,
        method: 'POST',
        raw_input: { key_id: keyId },
        policy_effect: 'allow',
        policy_reason: 'api_key_rotated',
      });
    }
    return c.json({ token: rotated.token, api_key: rotated.metadata }, 200);
  });
}
