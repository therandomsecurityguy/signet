import type { OpenAPIHono } from '@hono/zod-openapi';
import { createRoute } from '@hono/zod-openapi';
import { z } from 'zod';

import type { AuditPublisher } from '../../application/ports/audit-publisher.js';
import type { OntologyPackageUseCase } from '../../application/usecases/ontology-packages.js';
import { ApiError } from '../../domain/errors/api-error.js';
import { RegistryCoreError } from '../../../../registry/application/errors/registry-core-error.js';
import {
  CreateOntologyPackageInputSchema,
  ListOntologyPackagesOutputSchema,
  OntologyPackageDetailsSchema,
} from '../../contracts/ontology-packages.js';
import { ErrorResponseSchema } from '../../contracts/error.js';
import type { AppEnv } from '../server.js';
import { auditApiWrite } from './audit.js';

const listOntologyPackagesRoute = createRoute({
  method: 'get',
  path: '/v1/ontology-packages',
  responses: {
    200: { content: { 'application/json': { schema: ListOntologyPackagesOutputSchema } }, description: 'List ontology packages' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid query parameters' },
  },
});

const getOntologyPackageRoute = createRoute({
  method: 'get',
  path: '/v1/ontology-packages/{ontologyVersion}',
  request: { params: z.object({ ontologyVersion: z.string() }) },
  responses: {
    200: { content: { 'application/json': { schema: OntologyPackageDetailsSchema } }, description: 'Get ontology package' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid ontology version' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Ontology package not found' },
  },
});

const createOntologyPackageRoute = createRoute({
  method: 'post',
  path: '/v1/ontology-packages',
  request: { body: { content: { 'application/json': { schema: CreateOntologyPackageInputSchema } } } },
  responses: {
    200: { content: { 'application/json': { schema: z.any() } }, description: 'Ontology package already exists (idempotent)' },
    201: { content: { 'application/json': { schema: z.any() } }, description: 'Ontology package created' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid ontology package payload' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Ontology package not found' },
    409: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Ontology package conflict' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Internal error' },
  },
});

export function registerOntologyPackageRoutes(
  app: OpenAPIHono<AppEnv>,
  deps: {
    ontologyPackages: OntologyPackageUseCase;
    audit: AuditPublisher;
  },
) {
  app.openapi(listOntologyPackagesRoute, async (c) => {
    return c.json(await deps.ontologyPackages.list(), 200);
  });

  app.openapi(getOntologyPackageRoute, async (c) => {
    const { ontologyVersion } = c.req.valid('param');
    if (!ontologyVersion) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid ontology version.' } }, 400);
    }
    const got = await deps.ontologyPackages.get({ ontology_version: ontologyVersion });
    if (!got) {
      return c.json({ error: { code: 'ONTOLOGY_PACKAGE_NOT_FOUND', message: 'Ontology package not found.' } }, 404);
    }
    return c.json(got, 200);
  });

  app.openapi(createOntologyPackageRoute, async (c) => {
    const raw = await c.req.json().catch(() => undefined);
    const parsed = CreateOntologyPackageInputSchema.safeParse(raw);
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
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid ontology package payload.' } }, 400);
    }

    try {
      const created = await deps.ontologyPackages.create(parsed.data);
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
      return c.json({ ontology_package: created.value, created: created.created }, created.created ? 201 : 200);
    } catch (err) {
      const apiError = toOntologyPackageApiError(err);
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
          policy_reason: apiError.code,
          error_code: apiError.code,
        });
      }
      return c.json({ error: { code: apiError.code, message: apiError.message } }, apiError.httpStatus as 400 | 404 | 409 | 500);
    }
  });
}

function toOntologyPackageApiError(err: unknown): ApiError {
  if (err instanceof RegistryCoreError) {
    switch (err.code) {
      case 'ONTOLOGY_PACKAGE_INVALID':
        return new ApiError(err.code, 400, err.message);
      case 'ONTOLOGY_PACKAGE_CONFLICT':
        return new ApiError(err.code, 409, err.message);
      case 'ONTOLOGY_PACKAGE_NOT_FOUND':
        return new ApiError(err.code, 404, err.message);
      default:
        return new ApiError(err.code, 500, err.message);
    }
  }
  if (err instanceof ApiError) return err;
  return new ApiError('INTERNAL_ERROR', 500, 'Internal error.');
}
