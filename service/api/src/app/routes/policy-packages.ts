import type { OpenAPIHono } from '@hono/zod-openapi';
import { createRoute } from '@hono/zod-openapi';
import { z } from 'zod';

import type { AuditPublisher } from '../../application/ports/audit-publisher.js';
import type { PolicyPackageUseCase } from '../../application/usecases/policy-packages.js';
import { ApiError } from '../../domain/errors/api-error.js';
import { RegistryCoreError } from '../../../../registry/application/errors/registry-core-error.js';
import {
  CreatePolicyPackageInputSchema,
  ListPolicyPackagesOutputSchema,
  PolicyPackageDetailsSchema,
  PolicySimulationOutputSchema,
  SimulatePolicyPackageInputSchema,
} from '../../contracts/policy-packages.js';
import { ErrorResponseSchema } from '../../contracts/error.js';
import type { AppEnv } from '../server.js';
import { auditApiWrite } from './audit.js';

const listPolicyPackagesRoute = createRoute({
  method: 'get',
  path: '/v1/policy-packages',
  responses: {
    200: { content: { 'application/json': { schema: ListPolicyPackagesOutputSchema } }, description: 'List policy packages' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid query parameters' },
  },
});

const getPolicyPackageRoute = createRoute({
  method: 'get',
  path: '/v1/policy-packages/{policyVersion}',
  request: { params: z.object({ policyVersion: z.string() }) },
  responses: {
    200: { content: { 'application/json': { schema: PolicyPackageDetailsSchema } }, description: 'Get policy package' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid policy version' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Policy package not found' },
  },
});

const simulatePolicyPackageRoute = createRoute({
  method: 'post',
  path: '/v1/policy-packages/{policyVersion}/simulate',
  request: {
    params: z.object({ policyVersion: z.string().min(1) }),
    body: { content: { 'application/json': { schema: SimulatePolicyPackageInputSchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: PolicySimulationOutputSchema } },
      description: 'Simulation verdicts (dry-run: no reports, artifacts, tasks, events, or node writes)',
    },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid simulation payload' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Policy package not found' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Internal error' },
  },
});

const createPolicyPackageRoute = createRoute({
  method: 'post',
  path: '/v1/policy-packages',
  request: { body: { content: { 'application/json': { schema: CreatePolicyPackageInputSchema } } } },
  responses: {
    200: { content: { 'application/json': { schema: z.any() } }, description: 'Policy package already exists (idempotent)' },
    201: { content: { 'application/json': { schema: z.any() } }, description: 'Policy package created' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid policy package payload' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Policy package not found' },
    409: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Policy package conflict' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Internal error' },
  },
});

export function registerPolicyPackageRoutes(
  app: OpenAPIHono<AppEnv>,
  deps: {
    policyPackages: PolicyPackageUseCase;
    audit: AuditPublisher;
  },
) {
  app.openapi(listPolicyPackagesRoute, async (c) => {
    return c.json(await deps.policyPackages.list(), 200);
  });

  app.openapi(getPolicyPackageRoute, async (c) => {
    const { policyVersion } = c.req.valid('param');
    if (!policyVersion) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid policy version.' } }, 400);
    }
    const got = await deps.policyPackages.get({ policy_version: policyVersion });
    if (!got) {
      return c.json({ error: { code: 'POLICY_PACKAGE_NOT_FOUND', message: 'Policy package not found.' } }, 404);
    }
    return c.json(got, 200);
  });

  app.openapi(createPolicyPackageRoute, async (c) => {
    const raw = await c.req.json().catch(() => undefined);
    const parsed = CreatePolicyPackageInputSchema.safeParse(raw);
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
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid policy package payload.' } }, 400);
    }

    try {
      const created = await deps.policyPackages.create(parsed.data);
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
      return c.json({ policy_package: created.value, created: created.created }, created.created ? 201 : 200);
    } catch (err) {
      const apiError = toPolicyPackageApiError(err);
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

  app.openapi(simulatePolicyPackageRoute, async (c) => {
    const { policyVersion } = c.req.valid('param');
    const raw = await c.req.json().catch(() => undefined);
    const parsed = SimulatePolicyPackageInputSchema.safeParse(raw);
    const principal = c.get('principal');

    if (!policyVersion || !parsed.success) {
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
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid policy simulation payload.' } }, 400);
    }

    try {
      const result = await deps.policyPackages.simulate({
        policy_version: policyVersion,
        publication_urns: parsed.data.publication_urns,
      });
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
          policy_reason: 'operation_completed',
        });
      }
      return c.json(result, 200);
    } catch (err) {
      const apiError = toPolicyPackageApiError(err);
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
      return c.json({ error: { code: apiError.code, message: apiError.message } }, apiError.httpStatus as 400 | 404 | 500);
    }
  });
}

function toPolicyPackageApiError(err: unknown): ApiError {
  if (err instanceof RegistryCoreError) {
    switch (err.code) {
      case 'POLICY_PACKAGE_INVALID':
        return new ApiError(err.code, 400, err.message);
      case 'POLICY_PACKAGE_CONFLICT':
        return new ApiError(err.code, 409, err.message);
      case 'POLICY_PACKAGE_NOT_FOUND':
        return new ApiError(err.code, 404, err.message);
      default:
        return new ApiError(err.code, 500, err.message);
    }
  }
  if (err instanceof ApiError) return err;
  return new ApiError('INTERNAL_ERROR', 500, 'Internal error.');
}
