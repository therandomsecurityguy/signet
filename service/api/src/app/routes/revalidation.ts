import type { Context } from 'hono';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { createRoute } from '@hono/zod-openapi';
import { z } from 'zod';

import type { AuditPublisher } from '../../application/ports/audit-publisher.js';
import type { RevalidationUseCase } from '../../application/usecases/revalidation.js';
import { ApiError } from '../../domain/errors/api-error.js';
import { RegistryCoreError } from '../../../../registry/application/errors/registry-core-error.js';
import {
  CreateRevalidationJobInputSchema,
  CreateRevalidationJobOutputSchema,
  ExecuteRevalidationJobInputSchema,
  ExecuteRevalidationJobOutputSchema,
  GetRevalidationJobOutputSchema,
  ListRevalidationJobsOutputSchema,
  RecertificationQueueOutputSchema,
  RecertificationQueueQuerySchema,
} from '../../contracts/revalidation.js';
import { ErrorResponseSchema } from '../../contracts/error.js';
import type { AppEnv } from '../server.js';
import { auditApiWrite } from './audit.js';

const getRecertificationQueueRoute = createRoute({
  method: 'get',
  path: '/v1/recertification/queue',
  request: { query: RecertificationQueueQuerySchema },
  responses: {
    200: { content: { 'application/json': { schema: RecertificationQueueOutputSchema } }, description: 'Recertification queue (due first, then approaching)' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid queue query parameters' },
  },
});

const createRevalidationJobRoute = createRoute({
  method: 'post',
  path: '/v1/revalidation-jobs',
  request: { body: { content: { 'application/json': { schema: CreateRevalidationJobInputSchema } } } },
  responses: {
    200: { content: { 'application/json': { schema: CreateRevalidationJobOutputSchema } }, description: 'Revalidation job already exists (idempotent)' },
    201: { content: { 'application/json': { schema: CreateRevalidationJobOutputSchema } }, description: 'Revalidation job created' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid revalidation job payload' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Not found' },
    409: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Conflict' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Internal error' },
  },
});

const executeRevalidationJobRoute = createRoute({
  method: 'post',
  path: '/v1/revalidation-jobs/{jobId}/execute',
  request: {
    params: z.object({ jobId: z.string() }),
    body: { content: { 'application/json': { schema: ExecuteRevalidationJobInputSchema } } },
  },
  responses: {
    200: { content: { 'application/json': { schema: ExecuteRevalidationJobOutputSchema } }, description: 'Revalidation job executed (idempotent on replay)' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid revalidation job execute payload' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Not found' },
    409: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Conflict' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Internal error' },
  },
});

const listRevalidationJobsRoute = createRoute({
  method: 'get',
  path: '/v1/revalidation-jobs',
  responses: {
    200: { content: { 'application/json': { schema: ListRevalidationJobsOutputSchema } }, description: 'List revalidation jobs' },
  },
});

const getRevalidationJobRoute = createRoute({
  method: 'get',
  path: '/v1/revalidation-jobs/{jobId}',
  request: { params: z.object({ jobId: z.string() }) },
  responses: {
    200: { content: { 'application/json': { schema: GetRevalidationJobOutputSchema } }, description: 'Get revalidation job' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Not found' },
  },
});

export function registerRevalidationRoutes(
  app: OpenAPIHono<AppEnv>,
  deps: { revalidation: RevalidationUseCase; audit: AuditPublisher },
) {
  app.openapi(getRecertificationQueueRoute, async (c) => {
    const parsed = RecertificationQueueQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid queue query parameters.' } }, 400);
    }
    return c.json(
      await deps.revalidation.getQueue({
        state: parsed.data.state,
        entity_type: parsed.data.entity_type,
        ...(parsed.data.limit !== undefined ? { limit: parsed.data.limit } : {}),
        ...(parsed.data.offset !== undefined ? { offset: parsed.data.offset } : {}),
      }),
      200,
    );
  });

  app.openapi(createRevalidationJobRoute, async (c) => {
    const raw = await parseJsonBody(c);
    const parsed = CreateRevalidationJobInputSchema.safeParse(raw);
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
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid revalidation job payload.' } }, 400);
    }
    try {
      const created = await deps.revalidation.createJob({
        job_id: parsed.data.job_id,
        author: parsed.data.author,
        scope: parsed.data.scope,
        entity_type: parsed.data.entity_type,
        ...(parsed.data.limit !== undefined ? { limit: parsed.data.limit } : {}),
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
          policy_reason: created.created ? 'created' : 'idempotent',
        });
      }
      return c.json({ revalidation_job: created.value, created: created.created }, created.created ? 201 : 200);
    } catch (err) {
      const mapped = toRevalidationApiError(err);
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
      return c.json(
        { error: { code: mapped.code, message: mapped.message } },
        mapped.httpStatus as 400 | 404 | 409 | 500,
      );
    }
  });

  app.openapi(executeRevalidationJobRoute, async (c) => {
    const raw = await parseJsonBody(c);
    const parsed = ExecuteRevalidationJobInputSchema.safeParse(raw);
    const principal = c.get('principal');
    const jobId = c.req.param('jobId');
    if (!parsed.success || !jobId) {
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
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid revalidation job execute payload.' } }, 400);
    }
    try {
      const job = await deps.revalidation.executeJob({ job_id: jobId, author: parsed.data.author });
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
      return c.json({ revalidation_job: job }, 200);
    } catch (err) {
      const mapped = toRevalidationApiError(err);
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
      return c.json(
        { error: { code: mapped.code, message: mapped.message } },
        mapped.httpStatus as 400 | 404 | 409 | 500,
      );
    }
  });

  app.openapi(listRevalidationJobsRoute, async (c) => c.json(await deps.revalidation.listJobs(), 200));

  app.openapi(getRevalidationJobRoute, async (c) => {
    const jobId = c.req.param('jobId');
    const got = await deps.revalidation.getJob({ job_id: jobId });
    if (!got) {
      return c.json({ error: { code: 'REVALIDATION_JOB_NOT_FOUND', message: 'Revalidation job not found.' } }, 404);
    }
    return c.json({ revalidation_job: got }, 200);
  });
}

function toRevalidationApiError(err: unknown): ApiError {
  if (err instanceof RegistryCoreError) {
    switch (err.code) {
      case 'REVALIDATION_JOB_NOT_FOUND':
        return new ApiError(err.code, 404, err.message);
      case 'REVALIDATION_JOB_CREATE_CONFLICT':
      case 'REVALIDATION_JOB_EXECUTE_CONFLICT':
        return new ApiError(err.code, 409, err.message);
      default:
        return new ApiError(err.code, 500, err.message);
    }
  }
  if (err instanceof ApiError) return err;
  return new ApiError('INTERNAL_ERROR', 500, 'Internal error.');
}

async function parseJsonBody(c: Context<AppEnv>) {
  try {
    return await c.req.json();
  } catch {
    const text = await c.req.text().catch(() => '');
    if (!text) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  }
}
