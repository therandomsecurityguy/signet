import type { OpenAPIHono } from '@hono/zod-openapi';
import { createRoute } from '@hono/zod-openapi';
import { z } from 'zod';

import type { AuditPublisher } from '../../application/ports/audit-publisher.js';
import { CreateTrustedPublicKeyInputSchema, CreateTrustedPublicKeyOutputSchema } from '../../contracts/public-keys/create-public-key.js';
import { GetTrustedPublicKeyInputSchema, GetTrustedPublicKeyOutputSchema } from '../../contracts/public-keys/get-public-key.js';
import { ListTrustedPublicKeysInputSchema, ListTrustedPublicKeysOutputSchema } from '../../contracts/public-keys/list-public-keys.js';
import { RevokeTrustedPublicKeyInputSchema, RevokeTrustedPublicKeyOutputSchema } from '../../contracts/public-keys/revoke-public-key.js';
import { ErrorResponseSchema } from '../../contracts/error.js';
import { ApiError } from '../../domain/errors/api-error.js';
import { RegistryCoreError } from '../../../../registry/application/errors/registry-core-error.js';
import type { CreatePublicKeyUseCase } from '../../application/usecases/create-public-key.js';
import type { GetPublicKeyUseCase } from '../../application/usecases/get-public-key.js';
import type { ListPublicKeysUseCase } from '../../application/usecases/list-public-keys.js';
import type { RevokePublicKeyUseCase } from '../../application/usecases/revoke-public-key.js';
import type { AppEnv } from '../server.js';
import { auditApiWrite } from './audit.js';

const listPublicKeysRoute = createRoute({
  method: 'get',
  path: '/v1/public-keys',
  request: { query: ListTrustedPublicKeysInputSchema },
  responses: {
    200: { content: { 'application/json': { schema: ListTrustedPublicKeysOutputSchema } }, description: 'List trusted public keys' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid query parameters' },
  },
});

const getPublicKeyRoute = createRoute({
  method: 'get',
  path: '/v1/public-keys/{keyRef}',
  request: { params: z.object({ keyRef: z.string() }) },
  responses: {
    200: { content: { 'application/json': { schema: GetTrustedPublicKeyOutputSchema } }, description: 'Get trusted public key' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid key reference' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Trusted public key not found' },
  },
});

const createPublicKeyRoute = createRoute({
  method: 'post',
  path: '/v1/public-keys',
  request: { body: { content: { 'application/json': { schema: CreateTrustedPublicKeyInputSchema } } } },
  responses: {
    200: { content: { 'application/json': { schema: CreateTrustedPublicKeyOutputSchema } }, description: 'Trusted public key already exists (idempotent)' },
    201: { content: { 'application/json': { schema: CreateTrustedPublicKeyOutputSchema } }, description: 'Trusted public key created' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid trusted public key payload' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Trusted public key not found' },
    409: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Trusted public key conflict' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Internal error' },
  },
});

const revokePublicKeyRoute = createRoute({
  method: 'post',
  path: '/v1/public-keys/{keyRef}/revoke',
  request: {
    params: z.object({ keyRef: z.string() }),
    body: { content: { 'application/json': { schema: RevokeTrustedPublicKeyInputSchema } } },
  },
  responses: {
    200: { content: { 'application/json': { schema: RevokeTrustedPublicKeyOutputSchema } }, description: 'Trusted public key revoked' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid revoke trusted public key payload' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Trusted public key not found' },
    409: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Trusted public key conflict' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Internal error' },
  },
});

export function registerPublicKeyRoutes(
  app: OpenAPIHono<AppEnv>,
  deps: {
    listPublicKeys: ListPublicKeysUseCase;
    getPublicKey: GetPublicKeyUseCase;
    createPublicKey: CreatePublicKeyUseCase;
    revokePublicKey: RevokePublicKeyUseCase;
    audit: AuditPublisher;
  },
) {
  app.openapi(listPublicKeysRoute, async (c) => {
    const parsed = ListTrustedPublicKeysInputSchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid query parameters.' } }, 400);
    }
    const body = await deps.listPublicKeys.execute({
      ...(typeof parsed.data.limit === 'number' ? { limit: parsed.data.limit } : {}),
      ...(typeof parsed.data.offset === 'number' ? { offset: parsed.data.offset } : {}),
    });
    return c.json(body, 200);
  });

  app.openapi(getPublicKeyRoute, async (c) => {
    const { keyRef } = c.req.valid('param');
    const parsed = GetTrustedPublicKeyInputSchema.safeParse({ key_ref: keyRef });
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid key reference.' } }, 400);
    }
    const got = await deps.getPublicKey.execute(parsed.data);
    if (!got) {
      return c.json({ error: { code: 'PUBLIC_KEY_NOT_FOUND', message: 'Trusted public key not found.' } }, 404);
    }
    return c.json(got, 200);
  });

  app.openapi(createPublicKeyRoute, async (c) => {
    const raw = await c.req.json().catch(() => undefined);
    const parsed = CreateTrustedPublicKeyInputSchema.safeParse(raw);
    const principal = c.get('principal');
    if (!parsed.success) {
      if (principal) {
        await auditApiWrite({
          audit: deps.audit,
          request_id: c.get('requestId'),
          client_name: c.req.header('X-Agent-Client') ?? 'unknown',
          principal,
          path: c.req.path,
          method: 'POST',
          raw_input: raw,
          policy_effect: 'deny',
          policy_reason: 'validation_error',
          error_code: 'VALIDATION_ERROR',
        });
      }
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid trusted public key payload.' } }, 400);
    }

    try {
      const created = await deps.createPublicKey.execute(parsed.data);
      if (principal) {
        await auditApiWrite({
          audit: deps.audit,
          request_id: c.get('requestId'),
          client_name: c.req.header('X-Agent-Client') ?? 'unknown',
          principal,
          path: c.req.path,
          method: 'POST',
          raw_input: parsed.data,
          policy_effect: 'allow',
          policy_reason: created.created ? 'created' : 'idempotent',
        });
      }
      return c.json(created.value, created.created ? 201 : 200);
    } catch (err) {
      const mapped = mapPublicKeyError(err);
      if (principal) {
        await auditApiWrite({
          audit: deps.audit,
          request_id: c.get('requestId'),
          client_name: c.req.header('X-Agent-Client') ?? 'unknown',
          principal,
          path: c.req.path,
          method: 'POST',
          raw_input: parsed.data,
          policy_effect: 'deny',
          policy_reason: mapped.code,
          error_code: mapped.code,
        });
      }
      return c.json({ error: { code: mapped.code, message: mapped.message } }, mapped.httpStatus as 400 | 404 | 409 | 500);
    }
  });

  app.openapi(revokePublicKeyRoute, async (c) => {
    const raw = await c.req.json().catch(() => undefined);
    const parsed = RevokeTrustedPublicKeyInputSchema.safeParse(raw);
    const { keyRef } = c.req.valid('param');
    const principal = c.get('principal');
    if (!parsed.success || !keyRef) {
      if (principal) {
        await auditApiWrite({
          audit: deps.audit,
          request_id: c.get('requestId'),
          client_name: c.req.header('X-Agent-Client') ?? 'unknown',
          principal,
          path: c.req.path,
          method: 'POST',
          raw_input: raw,
          policy_effect: 'deny',
          policy_reason: 'validation_error',
          error_code: 'VALIDATION_ERROR',
        });
      }
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid revoke trusted public key payload.' } }, 400);
    }
    try {
      const result = await deps.revokePublicKey.execute({
        key_ref: keyRef,
        author: parsed.data.author,
        ...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
      });
      if (principal) {
        await auditApiWrite({
          audit: deps.audit,
          request_id: c.get('requestId'),
          client_name: c.req.header('X-Agent-Client') ?? 'unknown',
          principal,
          path: c.req.path,
          method: 'POST',
          raw_input: { key_ref: keyRef, ...parsed.data },
          policy_effect: 'allow',
          policy_reason: 'operation_completed',
        });
      }
      return c.json(result, 200);
    } catch (err) {
      const mapped = mapPublicKeyError(err);
      if (principal) {
        await auditApiWrite({
          audit: deps.audit,
          request_id: c.get('requestId'),
          client_name: c.req.header('X-Agent-Client') ?? 'unknown',
          principal,
          path: c.req.path,
          method: 'POST',
          raw_input: { key_ref: keyRef, ...parsed.data },
          policy_effect: 'deny',
          policy_reason: mapped.code,
          error_code: mapped.code,
        });
      }
      return c.json({ error: { code: mapped.code, message: mapped.message } }, mapped.httpStatus as 400 | 404 | 409 | 500);
    }
  });
}

function mapPublicKeyError(err: unknown) {
  if (err instanceof RegistryCoreError) {
    switch (err.code) {
      case 'PUBLIC_KEY_INVALID':
        return new ApiError(err.code, 400, err.message);
      case 'PUBLIC_KEY_NOT_FOUND':
        return new ApiError(err.code, 404, err.message);
      case 'PUBLIC_KEY_CREATE_CONFLICT':
        return new ApiError(err.code, 409, err.message);
      case 'PUBLIC_KEY_CREATE_FAILED':
        return new ApiError(err.code, 500, err.message);
      case 'DETACHED_SIGNATURE_FORMAT_INVALID':
        return new ApiError(err.code, 400, err.message);
      default:
        return new ApiError(err.code, 500, err.message);
    }
  }
  if (err instanceof ApiError) return err;
  return new ApiError('INTERNAL_ERROR', 500, 'Internal error.');
}
