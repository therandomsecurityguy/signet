import type { OpenAPIHono } from '@hono/zod-openapi';
import { createRoute } from '@hono/zod-openapi';
import { z } from 'zod';

import { RegistryCoreError } from '../../../../registry/application/errors/registry-core-error.js';
import type { AuditPublisher } from '../../application/ports/audit-publisher.js';
import type { AdvisoriesUseCase } from '../../application/usecases/advisories.js';
import {
  AdvisoryRecordSchema,
  CreateAdvisoryInputSchema,
  ListAdvisoriesOutputSchema,
} from '../../contracts/publication/advisories.js';
import { ErrorResponseSchema } from '../../contracts/error.js';
import type { AppEnv } from '../server.js';
import { auditApiWrite } from './audit.js';

const createAdvisoryRoute = createRoute({
  method: 'post',
  path: '/v1/advisories',
  request: {
    body: { content: { 'application/json': { schema: CreateAdvisoryInputSchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: z.object({ advisory: AdvisoryRecordSchema }) } },
      description: 'Advisory verified, mapped to publications, and recorded',
    },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid advisory payload' },
    409: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Advisory rejected' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Internal error' },
  },
});

const listAdvisoriesRoute = createRoute({
  method: 'get',
  path: '/v1/advisories',
  request: {
    query: z.object({
      limit: z.string().optional(),
      offset: z.string().optional(),
    }),
  },
  responses: {
    200: { content: { 'application/json': { schema: ListAdvisoriesOutputSchema } }, description: 'Recorded advisories' },
  },
});

const getAdvisoryRoute = createRoute({
  method: 'get',
  path: '/v1/advisories/{advisoryId}',
  request: { params: z.object({ advisoryId: z.string() }) },
  responses: {
    200: {
      content: { 'application/json': { schema: z.object({ advisory: AdvisoryRecordSchema }) } },
      description: 'Recorded advisory with its affected publications',
    },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Advisory not found' },
  },
});

const ADVISORY_ERROR_STATUS: Record<string, 409> = {
  ADVISORY_EXISTS: 409,
  ADVISORY_TRUSTED_KEY_NOT_FOUND: 409,
  ADVISORY_SIGNATURE_INVALID: 409,
};

function toAdvisoryApiError(err: unknown): { status: 409 | 500; code: string; message: string } {
  if (err instanceof RegistryCoreError) {
    return {
      status: ADVISORY_ERROR_STATUS[err.code] ?? 500,
      code: err.code,
      message: err.message,
    };
  }
  return { status: 500, code: 'INTERNAL_ERROR', message: 'Internal error.' };
}

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

export function registerAdvisoryRoutes(
  app: OpenAPIHono<AppEnv>,
  deps: {
    advisories: AdvisoriesUseCase;
    audit: AuditPublisher;
  },
) {
  app.openapi(createAdvisoryRoute, async (c) => {
    const raw = await c.req.json().catch(() => undefined);
    const parsed = CreateAdvisoryInputSchema.safeParse(raw);
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
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid advisory payload.' } }, 400);
    }

    try {
      const ingested = await deps.advisories.ingest(parsed.data);
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
          policy_reason: `advisory_${parsed.data.mode ?? 'report'}`,
        });
      }
      return c.json({ advisory: ingested.advisory }, 200);
    } catch (err) {
      const mapped = toAdvisoryApiError(err);
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
          policy_reason: 'advisory_rejected',
          error_code: mapped.code,
        });
      }
      return c.json({ error: { code: mapped.code, message: mapped.message } }, mapped.status);
    }
  });

  app.openapi(listAdvisoriesRoute, async (c) => {
    const limit = parsePositiveInt(c.req.query('limit'));
    const offset = parsePositiveInt(c.req.query('offset'));
    const listed = await deps.advisories.list({
      ...(limit ? { limit } : {}),
      ...(offset ? { offset } : {}),
    });
    return c.json(listed, 200);
  });

  app.openapi(getAdvisoryRoute, async (c) => {
    const advisoryId = c.req.param('advisoryId');
    const got = await deps.advisories.get({ advisory_id: advisoryId });
    if (!got) {
      return c.json({ error: { code: 'ADVISORY_NOT_FOUND', message: 'Advisory not found.' } }, 404);
    }
    return c.json(got, 200);
  });
}
