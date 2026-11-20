import type { OpenAPIHono } from '@hono/zod-openapi';
import { createRoute } from '@hono/zod-openapi';
import { z } from 'zod';

import type { AuditPublisher } from '../../application/ports/audit-publisher.js';
import type { CompileUseCase, DeFactoTermsUseCase } from '../../application/usecases/compile.js';
import { ApiError } from '../../domain/errors/api-error.js';
import { RegistryCoreError } from '../../../../registry/application/errors/registry-core-error.js';
import { CompileSkillInputSchema, ReviewDeFactoTermInputSchema } from '../../contracts/compile.js';
import { ErrorResponseSchema } from '../../contracts/error.js';
import type { AppEnv } from '../server.js';
import { auditApiWrite } from './audit.js';

const compileSkillRoute = createRoute({
  method: 'post',
  path: '/v1/compile/skill',
  request: { body: { content: { 'application/json': { schema: CompileSkillInputSchema } } } },
  responses: {
    200: { content: { 'application/json': { schema: z.any() } }, description: 'Compiled skill' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid compile payload' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Not found' },
    409: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Conflict' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Internal error' },
  },
});

const listDeFactoTermsRoute = createRoute({
  method: 'get',
  path: '/v1/de-facto-terms',
  request: {
    query: z.object({ status: z.enum(['candidate', 'promoted', 'rejected']).optional() }),
  },
  responses: {
    200: { content: { 'application/json': { schema: z.any() } }, description: 'List de facto terms' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid status filter' },
  },
});

const analyzeDeFactoTermsRoute = createRoute({
  method: 'get',
  path: '/v1/de-facto-terms/analysis',
  request: {
    query: z.object({ ontology_version: z.string().min(1).max(200).optional() }),
  },
  responses: {
    200: {
      content: { 'application/json': { schema: z.any() } },
      description: 'Read-only corpus analysis of capability claims against resolved skill-area ontologies',
    },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid query parameters' },
  },
});

const reviewDeFactoTermRoute = createRoute({
  method: 'post',
  path: '/v1/de-facto-terms/{term}/review',
  request: {
    // Terms are free-form claims; the URN builder strictly percent-encodes
    // them, so only length/shape sanity is enforced here.
    params: z.object({ term: z.string().min(1).max(200) }),
    body: { content: { 'application/json': { schema: ReviewDeFactoTermInputSchema } } },
  },
  responses: {
    200: { content: { 'application/json': { schema: z.any() } }, description: 'De facto term reviewed' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid review payload' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Not found' },
    409: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Conflict' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Internal error' },
  },
});

export function registerCompileRoutes(
  app: OpenAPIHono<AppEnv>,
  deps: {
    compile: CompileUseCase;
    deFactoTerms: DeFactoTermsUseCase;
    audit: AuditPublisher;
  },
) {
  app.openapi(compileSkillRoute, async (c) => {
    const raw = await c.req.json().catch(() => undefined);
    const parsed = CompileSkillInputSchema.safeParse(raw);
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
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid compile payload.' } }, 400);
    }

    try {
      const result = await deps.compile.compileSkill(parsed.data);
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
      const apiError = toCompileApiError(err);
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

  app.openapi(listDeFactoTermsRoute, async (c) => {
    const status = c.req.query('status');
    if (status && status !== 'candidate' && status !== 'promoted' && status !== 'rejected') {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid status filter.' } }, 400);
    }
    return c.json(await deps.deFactoTerms.list(status ? { status: status as 'candidate' | 'promoted' | 'rejected' } : undefined), 200);
  });

  app.openapi(analyzeDeFactoTermsRoute, async (c) => {
    const ontologyVersion = c.req.query('ontology_version');
    return c.json(
      await deps.deFactoTerms.analyze(ontologyVersion ? { ontology_version: ontologyVersion } : undefined),
      200,
    );
  });

  app.openapi(reviewDeFactoTermRoute, async (c) => {
    const raw = await c.req.json().catch(() => undefined);
    const parsed = ReviewDeFactoTermInputSchema.safeParse(raw);
    const term = c.req.param('term');
    const principal = c.get('principal');

    if (!parsed.success || !term) {
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
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid de facto term review payload.' } }, 400);
    }

    try {
      const result = await deps.deFactoTerms.review({ term, ...parsed.data });
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
      const apiError = toCompileApiError(err);
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

function toCompileApiError(err: unknown): ApiError {
  if (err instanceof RegistryCoreError) {
    switch (err.code) {
      case 'SEMANTIC_COMPILE_INVALID':
      case 'DEFACTO_TERM_PROMOTE_INVALID':
        return new ApiError(err.code, 400, err.message);
      case 'DEFACTO_TERM_NOT_FOUND':
      case 'ONTOLOGY_PACKAGE_NOT_FOUND':
        return new ApiError(err.code, 404, err.message);
      case 'DEFACTO_TERM_REVIEW_CONFLICT':
      case 'DEFACTO_TERM_PROMOTE_CONFLICT':
      case 'ONTOLOGY_PACKAGE_CONFLICT':
        return new ApiError(err.code, 409, err.message);
      default:
        return new ApiError(err.code, 500, err.message);
    }
  }
  if (err instanceof ApiError) return err;
  return new ApiError('INTERNAL_ERROR', 500, 'Internal error.');
}
