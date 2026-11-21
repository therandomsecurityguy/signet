import type { OpenAPIHono } from '@hono/zod-openapi';
import { createRoute } from '@hono/zod-openapi';
import { z } from 'zod';

import type { AuditPublisher } from '../../application/ports/audit-publisher.js';
import { CreateTransparencyCheckpointInputSchema, TransparencyLogVerificationSchema } from '../../contracts/transparency-logs/create-transparency-checkpoint.js';
import { CreateTransparencyGossipEventInputSchema } from '../../contracts/transparency-logs/create-transparency-gossip-event.js';
import { CreateTransparencyLogInputSchema, CreateTransparencyLogOutputSchema } from '../../contracts/transparency-logs/create-transparency-log.js';
import { CreateTransparencyObservationInputSchema } from '../../contracts/transparency-logs/create-transparency-observation.js';
import { CreateTransparencyWitnessInputSchema, CreateTransparencyWitnessOutputSchema } from '../../contracts/transparency-logs/create-transparency-witness.js';
import { GetTransparencyLogInputSchema, GetTransparencyLogOutputSchema } from '../../contracts/transparency-logs/get-transparency-log.js';
import { TransparencyTimelineOutputSchema } from '../../contracts/transparency-logs/get-transparency-timeline.js';
import { ListTransparencyLogsInputSchema, ListTransparencyLogsOutputSchema } from '../../contracts/transparency-logs/list-transparency-logs.js';
import { ReconcilePublicationTransparencyInputSchema, ReconcilePublicationTransparencyOutputSchema } from '../../contracts/transparency-logs/reconcile-publication-transparency.js';
import { ErrorResponseSchema } from '../../contracts/error.js';
import { ApiError } from '../../domain/errors/api-error.js';
import { RegistryCoreError } from '../../../../registry/application/errors/registry-core-error.js';
import type { CreateTransparencyCheckpointUseCase } from '../../application/usecases/create-transparency-checkpoint.js';
import type { CreateTransparencyGossipEventUseCase } from '../../application/usecases/create-transparency-gossip-event.js';
import type { CreateTransparencyLogUseCase } from '../../application/usecases/create-transparency-log.js';
import type { CreateTransparencyObservationUseCase } from '../../application/usecases/create-transparency-observation.js';
import type { CreateTransparencyWitnessUseCase } from '../../application/usecases/create-transparency-witness.js';
import type { GetTransparencyLogUseCase } from '../../application/usecases/get-transparency-log.js';
import type { GetTransparencyLogTimelineUseCase } from '../../application/usecases/get-transparency-log-timeline.js';
import type { GetTransparencyLogVerificationUseCase } from '../../application/usecases/get-transparency-log-verification.js';
import type { ListTransparencyLogsUseCase } from '../../application/usecases/list-transparency-logs.js';
import type { ReconcilePublicationTransparencyUseCase } from '../../application/usecases/reconcile-publication-transparency.js';
import type { AppEnv } from '../server.js';
import { auditApiWrite } from './audit.js';

const listTransparencyLogsRoute = createRoute({
  method: 'get',
  path: '/v1/transparency-logs',
  request: { query: ListTransparencyLogsInputSchema },
  responses: {
    200: { content: { 'application/json': { schema: ListTransparencyLogsOutputSchema } }, description: 'List transparency logs' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid query parameters' },
  },
});

const getTransparencyLogRoute = createRoute({
  method: 'get',
  path: '/v1/transparency-logs/{logId}',
  request: { params: z.object({ logId: z.string() }) },
  responses: {
    200: { content: { 'application/json': { schema: GetTransparencyLogOutputSchema } }, description: 'Get transparency log' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid transparency log id' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Transparency log not found' },
  },
});

const getTransparencyLogVerificationRoute = createRoute({
  method: 'get',
  path: '/v1/transparency-logs/{logId}/verification',
  request: { params: z.object({ logId: z.string() }) },
  responses: {
    200: { content: { 'application/json': { schema: TransparencyLogVerificationSchema } }, description: 'Get transparency log verification' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid transparency log id' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Transparency log not found' },
  },
});

const getTransparencyLogTimelineRoute = createRoute({
  method: 'get',
  path: '/v1/transparency-logs/{logId}/timeline',
  request: { params: z.object({ logId: z.string() }) },
  responses: {
    200: { content: { 'application/json': { schema: TransparencyTimelineOutputSchema } }, description: 'Get transparency log timeline' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid transparency log id' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Transparency log not found' },
  },
});

const reconcilePublicationTransparencyRoute = createRoute({
  method: 'post',
  path: '/v1/transparency-logs/reconcile',
  request: { body: { content: { 'application/json': { schema: ReconcilePublicationTransparencyInputSchema } } } },
  responses: {
    200: { content: { 'application/json': { schema: ReconcilePublicationTransparencyOutputSchema } }, description: 'Transparency reconciliation report' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid reconciliation payload' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Publication not found' },
    409: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Reconciliation not configured' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Internal error' },
  },
});

const createTransparencyLogRoute = createRoute({
  method: 'post',
  path: '/v1/transparency-logs',
  request: { body: { content: { 'application/json': { schema: CreateTransparencyLogInputSchema } } } },
  responses: {
    200: { content: { 'application/json': { schema: CreateTransparencyLogOutputSchema } }, description: 'Transparency log already exists (idempotent)' },
    201: { content: { 'application/json': { schema: CreateTransparencyLogOutputSchema } }, description: 'Transparency log created' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid transparency log payload' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Not found' },
    409: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Conflict' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Internal error' },
  },
});

const createTransparencyWitnessRoute = createRoute({
  method: 'post',
  path: '/v1/transparency-logs/{logId}/witnesses',
  request: {
    params: z.object({ logId: z.string() }),
    body: { content: { 'application/json': { schema: CreateTransparencyWitnessInputSchema } } },
  },
  responses: {
    200: { content: { 'application/json': { schema: CreateTransparencyWitnessOutputSchema } }, description: 'Witness already exists (idempotent)' },
    201: { content: { 'application/json': { schema: CreateTransparencyWitnessOutputSchema } }, description: 'Witness created' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid transparency witness payload' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Not found' },
    409: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Conflict' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Internal error' },
  },
});

const createTransparencyCheckpointRoute = createRoute({
  method: 'post',
  path: '/v1/transparency-logs/{logId}/checkpoints',
  request: {
    params: z.object({ logId: z.string() }),
    body: { content: { 'application/json': { schema: CreateTransparencyCheckpointInputSchema } } },
  },
  responses: {
    200: { content: { 'application/json': { schema: z.any() } }, description: 'Checkpoint registered' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid transparency checkpoint payload' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Not found' },
    409: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Conflict' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Internal error' },
  },
});

const createTransparencyObservationRoute = createRoute({
  method: 'post',
  path: '/v1/transparency-logs/{logId}/observations',
  request: {
    params: z.object({ logId: z.string() }),
    body: { content: { 'application/json': { schema: CreateTransparencyObservationInputSchema } } },
  },
  responses: {
    200: { content: { 'application/json': { schema: z.any() } }, description: 'Observation recorded' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid transparency observation payload' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Not found' },
    409: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Conflict' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Internal error' },
  },
});

const createTransparencyGossipEventRoute = createRoute({
  method: 'post',
  path: '/v1/transparency-logs/{logId}/gossip-events',
  request: {
    params: z.object({ logId: z.string() }),
    body: { content: { 'application/json': { schema: CreateTransparencyGossipEventInputSchema } } },
  },
  responses: {
    200: { content: { 'application/json': { schema: z.any() } }, description: 'Gossip event recorded' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid transparency gossip payload' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Not found' },
    409: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Conflict' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Internal error' },
  },
});

export function registerTransparencyLogRoutes(
  app: OpenAPIHono<AppEnv>,
  deps: {
    listTransparencyLogs: ListTransparencyLogsUseCase;
    getTransparencyLog: GetTransparencyLogUseCase;
    createTransparencyLog: CreateTransparencyLogUseCase;
    createTransparencyObservation: CreateTransparencyObservationUseCase;
    createTransparencyGossipEvent: CreateTransparencyGossipEventUseCase;
    createTransparencyWitness: CreateTransparencyWitnessUseCase;
    createTransparencyCheckpoint: CreateTransparencyCheckpointUseCase;
    getTransparencyLogTimeline: GetTransparencyLogTimelineUseCase;
    getTransparencyLogVerification: GetTransparencyLogVerificationUseCase;
    reconcilePublicationTransparency: ReconcilePublicationTransparencyUseCase;
    audit: AuditPublisher;
  },
) {
  app.openapi(listTransparencyLogsRoute, async (c) => {
    const parsed = ListTransparencyLogsInputSchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid query parameters.' } }, 400);
    }
    const body = await deps.listTransparencyLogs.execute({
      ...(typeof parsed.data.limit === 'number' ? { limit: parsed.data.limit } : {}),
      ...(typeof parsed.data.offset === 'number' ? { offset: parsed.data.offset } : {}),
    });
    return c.json(body, 200);
  });

  app.openapi(getTransparencyLogRoute, async (c) => {
    const parsed = GetTransparencyLogInputSchema.safeParse({ log_id: c.req.param('logId') });
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid transparency log id.' } }, 400);
    }
    const got = await deps.getTransparencyLog.execute(parsed.data);
    if (!got) {
      return c.json({ error: { code: 'TRANSPARENCY_LOG_NOT_FOUND', message: 'Transparency log not found.' } }, 404);
    }
    return c.json(got, 200);
  });

  app.openapi(getTransparencyLogVerificationRoute, async (c) => {
    const parsed = GetTransparencyLogInputSchema.safeParse({ log_id: c.req.param('logId') });
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid transparency log id.' } }, 400);
    }
    const got = await deps.getTransparencyLogVerification.execute(parsed.data);
    if (!got) {
      return c.json({ error: { code: 'TRANSPARENCY_LOG_NOT_FOUND', message: 'Transparency log not found.' } }, 404);
    }
    const checked = TransparencyLogVerificationSchema.parse(got);
    return c.json(checked, 200);
  });

  app.openapi(getTransparencyLogTimelineRoute, async (c) => {
    const parsed = GetTransparencyLogInputSchema.safeParse({ log_id: c.req.param('logId') });
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid transparency log id.' } }, 400);
    }
    const got = await deps.getTransparencyLogTimeline.execute(parsed.data);
    if (!got) {
      return c.json({ error: { code: 'TRANSPARENCY_LOG_NOT_FOUND', message: 'Transparency log not found.' } }, 404);
    }
    const checked = TransparencyTimelineOutputSchema.parse(got);
    return c.json(checked, 200);
  });

  app.openapi(reconcilePublicationTransparencyRoute, async (c) => {
    const raw = await c.req.json().catch(() => undefined);
    const parsed = ReconcilePublicationTransparencyInputSchema.safeParse(raw);
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
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid reconciliation payload.' } }, 400);
    }
    try {
      const reconciled = await deps.reconcilePublicationTransparency.execute({
        publication_urn: parsed.data.publication_urn,
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
          policy_reason: reconciled.status,
        });
      }
      const checked = ReconcilePublicationTransparencyOutputSchema.parse(reconciled);
      return c.json(checked, 200);
    } catch (err) {
      const mapped = mapTransparencyLogError(err);
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

  app.openapi(createTransparencyLogRoute, async (c) => {
    const raw = await c.req.json().catch(() => undefined);
    const parsed = CreateTransparencyLogInputSchema.safeParse(raw);
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
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid transparency log payload.' } }, 400);
    }
    try {
      const created = await deps.createTransparencyLog.execute({
        log_id: parsed.data.log_id,
        origin: parsed.data.origin,
        checkpoint_key_ref: parsed.data.checkpoint_key_ref,
        ...(parsed.data.log_type ? { log_type: parsed.data.log_type } : {}),
        ...(parsed.data.trust_scope ? { trust_scope: parsed.data.trust_scope } : {}),
        ...(parsed.data.valid_from ? { valid_from: parsed.data.valid_from } : {}),
        ...(parsed.data.valid_to ? { valid_to: parsed.data.valid_to } : {}),
        ...(typeof parsed.data.witness_quorum === 'number' ? { witness_quorum: parsed.data.witness_quorum } : {}),
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
      return c.json(created.value, created.created ? 201 : 200);
    } catch (err) {
      const mapped = mapTransparencyLogError(err);
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

  app.openapi(createTransparencyWitnessRoute, async (c) => {
    const raw = await c.req.json().catch(() => undefined);
    const parsed = CreateTransparencyWitnessInputSchema.safeParse(raw);
    const logId = c.req.param('logId');
    const principal = c.get('principal');
    if (!parsed.success || !logId) {
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
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid transparency witness payload.' } }, 400);
    }
    try {
      const created = await deps.createTransparencyWitness.execute({
        log_id: logId,
        witness_id: parsed.data.witness_id,
        key_ref: parsed.data.key_ref,
        ...(parsed.data.witness_type ? { witness_type: parsed.data.witness_type } : {}),
        ...(parsed.data.valid_from ? { valid_from: parsed.data.valid_from } : {}),
        ...(parsed.data.valid_to ? { valid_to: parsed.data.valid_to } : {}),
      });
      if (principal) {
        await auditApiWrite({
          audit: deps.audit,
          request_id: c.get('requestId'),
          client_name: c.req.header('X-Agent-Client') ?? 'unknown',
          principal,
          path: c.req.path,
          method: 'POST',
          raw_input: { log_id: logId, ...parsed.data },
          policy_effect: 'allow',
          policy_reason: created.created ? 'created' : 'idempotent',
        });
      }
      return c.json(created.value, created.created ? 201 : 200);
    } catch (err) {
      const mapped = mapTransparencyLogError(err);
      if (principal) {
        await auditApiWrite({
          audit: deps.audit,
          request_id: c.get('requestId'),
          client_name: c.req.header('X-Agent-Client') ?? 'unknown',
          principal,
          path: c.req.path,
          method: 'POST',
          raw_input: { log_id: logId, ...parsed.data },
          policy_effect: 'deny',
          policy_reason: mapped.code,
          error_code: mapped.code,
        });
      }
      return c.json({ error: { code: mapped.code, message: mapped.message } }, mapped.httpStatus as 400 | 404 | 409 | 500);
    }
  });

  app.openapi(createTransparencyCheckpointRoute, async (c) => {
    const raw = await c.req.json().catch(() => undefined);
    const parsed = CreateTransparencyCheckpointInputSchema.safeParse(raw);
    const logId = c.req.param('logId');
    const principal = c.get('principal');
    if (!parsed.success || !logId) {
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
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid transparency checkpoint payload.' } }, 400);
    }
    try {
      const result = await deps.createTransparencyCheckpoint.execute({
        log_id: logId,
        ...(parsed.data.checkpoint_body ? { checkpoint_body: parsed.data.checkpoint_body } : {}),
        ...(parsed.data.checkpoint_signature ? { checkpoint_signature: parsed.data.checkpoint_signature } : {}),
        ...(parsed.data.signed_note ? { signed_note: parsed.data.signed_note } : {}),
        ...(parsed.data.consistency_proof ? { consistency_proof: parsed.data.consistency_proof } : {}),
        ...(parsed.data.witness_attestations ? { witness_attestations: parsed.data.witness_attestations } : {}),
        ...(parsed.data.transparency_log_ref ? { transparency_log_ref: parsed.data.transparency_log_ref } : {}),
      });
      if (principal) {
        await auditApiWrite({
          audit: deps.audit,
          request_id: c.get('requestId'),
          client_name: c.req.header('X-Agent-Client') ?? 'unknown',
          principal,
          path: c.req.path,
          method: 'POST',
          raw_input: { log_id: logId, ...parsed.data },
          policy_effect: 'allow',
          policy_reason: 'operation_completed',
        });
      }
      return c.json(result, 200);
    } catch (err) {
      const mapped = mapTransparencyLogError(err);
      if (principal) {
        await auditApiWrite({
          audit: deps.audit,
          request_id: c.get('requestId'),
          client_name: c.req.header('X-Agent-Client') ?? 'unknown',
          principal,
          path: c.req.path,
          method: 'POST',
          raw_input: { log_id: logId, ...parsed.data },
          policy_effect: 'deny',
          policy_reason: mapped.code,
          error_code: mapped.code,
        });
      }
      return c.json({ error: { code: mapped.code, message: mapped.message } }, mapped.httpStatus as 400 | 404 | 409 | 500);
    }
  });

  app.openapi(createTransparencyObservationRoute, async (c) => {
    const raw = await c.req.json().catch(() => undefined);
    const parsed = CreateTransparencyObservationInputSchema.safeParse(raw);
    const logId = c.req.param('logId');
    const principal = c.get('principal');
    if (!parsed.success || !logId) {
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
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid transparency observation payload.' } }, 400);
    }
    try {
      const result = await deps.createTransparencyObservation.execute({
        log_id: logId,
        ...(parsed.data.checkpoint_body ? { checkpoint_body: parsed.data.checkpoint_body } : {}),
        ...(parsed.data.checkpoint_signature ? { checkpoint_signature: parsed.data.checkpoint_signature } : {}),
        ...(parsed.data.signed_note ? { signed_note: parsed.data.signed_note } : {}),
        observed_from_type: parsed.data.observed_from_type,
        observed_from_id: parsed.data.observed_from_id,
        ...(parsed.data.observed_at ? { observed_at: parsed.data.observed_at } : {}),
        ...(parsed.data.source_channel ? { source_channel: parsed.data.source_channel } : {}),
        ...(parsed.data.observer_id ? { observer_id: parsed.data.observer_id } : {}),
        ...(parsed.data.observer_type ? { observer_type: parsed.data.observer_type } : {}),
        ...(parsed.data.relay_from_type ? { relay_from_type: parsed.data.relay_from_type } : {}),
        ...(parsed.data.relay_from_id ? { relay_from_id: parsed.data.relay_from_id } : {}),
        ...(typeof parsed.data.relay_hop_count === 'number' ? { relay_hop_count: parsed.data.relay_hop_count } : {}),
        ...(parsed.data.source_checkpoint_occurred_at
          ? { source_checkpoint_occurred_at: parsed.data.source_checkpoint_occurred_at }
          : {}),
      });
      if (principal) {
        await auditApiWrite({
          audit: deps.audit,
          request_id: c.get('requestId'),
          client_name: c.req.header('X-Agent-Client') ?? 'unknown',
          principal,
          path: c.req.path,
          method: 'POST',
          raw_input: { log_id: logId, ...parsed.data },
          policy_effect: 'allow',
          policy_reason: 'operation_completed',
        });
      }
      return c.json(result, 200);
    } catch (err) {
      const mapped = mapTransparencyLogError(err);
      if (principal) {
        await auditApiWrite({
          audit: deps.audit,
          request_id: c.get('requestId'),
          client_name: c.req.header('X-Agent-Client') ?? 'unknown',
          principal,
          path: c.req.path,
          method: 'POST',
          raw_input: { log_id: logId, ...parsed.data },
          policy_effect: 'deny',
          policy_reason: mapped.code,
          error_code: mapped.code,
        });
      }
      return c.json({ error: { code: mapped.code, message: mapped.message } }, mapped.httpStatus as 400 | 404 | 409 | 500);
    }
  });

  app.openapi(createTransparencyGossipEventRoute, async (c) => {
    const raw = await c.req.json().catch(() => undefined);
    const parsed = CreateTransparencyGossipEventInputSchema.safeParse(raw);
    const logId = c.req.param('logId');
    const principal = c.get('principal');
    if (!parsed.success || !logId) {
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
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid transparency gossip payload.' } }, 400);
    }
    try {
      const result = await deps.createTransparencyGossipEvent.execute({
        log_id: logId,
        from_witness_id: parsed.data.from_witness_id,
        to_witness_id: parsed.data.to_witness_id,
        checkpoint_artifact_urn: parsed.data.checkpoint_artifact_urn,
        ...(parsed.data.occurred_at ? { occurred_at: parsed.data.occurred_at } : {}),
        ...(parsed.data.source_channel ? { source_channel: parsed.data.source_channel } : {}),
        ...(parsed.data.relayed_by_id ? { relayed_by_id: parsed.data.relayed_by_id } : {}),
        ...(typeof parsed.data.relay_hop_count === 'number' ? { relay_hop_count: parsed.data.relay_hop_count } : {}),
        ...(parsed.data.source_checkpoint_occurred_at
          ? { source_checkpoint_occurred_at: parsed.data.source_checkpoint_occurred_at }
          : {}),
      });
      if (principal) {
        await auditApiWrite({
          audit: deps.audit,
          request_id: c.get('requestId'),
          client_name: c.req.header('X-Agent-Client') ?? 'unknown',
          principal,
          path: c.req.path,
          method: 'POST',
          raw_input: { log_id: logId, ...parsed.data },
          policy_effect: 'allow',
          policy_reason: 'operation_completed',
        });
      }
      return c.json(result, 200);
    } catch (err) {
      const mapped = mapTransparencyLogError(err);
      if (principal) {
        await auditApiWrite({
          audit: deps.audit,
          request_id: c.get('requestId'),
          client_name: c.req.header('X-Agent-Client') ?? 'unknown',
          principal,
          path: c.req.path,
          method: 'POST',
          raw_input: { log_id: logId, ...parsed.data },
          policy_effect: 'deny',
          policy_reason: mapped.code,
          error_code: mapped.code,
        });
      }
      return c.json({ error: { code: mapped.code, message: mapped.message } }, mapped.httpStatus as 400 | 404 | 409 | 500);
    }
  });
}

function mapTransparencyLogError(err: unknown) {
  if (err instanceof RegistryCoreError) {
    switch (err.code) {
      case 'TRANSPARENCY_LOG_INVALID_CHECKPOINT_KEY':
        return new ApiError(err.code, 409, err.message);
      case 'TRANSPARENCY_LOG_CREATE_CONFLICT':
        return new ApiError(err.code, 409, err.message);
      case 'TRANSPARENCY_LOG_CREATE_FAILED':
        return new ApiError(err.code, 500, err.message);
      case 'TRANSPARENCY_LOG_NOT_FOUND':
        return new ApiError(err.code, 404, err.message);
      case 'TRANSPARENCY_RECONCILIATION_NOT_CONFIGURED':
        return new ApiError(err.code, 409, err.message);
      case 'TRANSPARENCY_RECONCILIATION_INVALID':
      case 'PUBLICATION_NOT_FOUND':
        return new ApiError(err.code, 404, err.message);
      case 'TRANSPARENCY_WITNESS_INVALID_KEY':
      case 'TRANSPARENCY_WITNESS_CREATE_CONFLICT':
      case 'TRANSPARENCY_CHECKPOINT_INVALID':
      case 'TRANSPARENCY_GOSSIP_INVALID_WITNESS':
      case 'TRANSPARENCY_GOSSIP_UNTRUSTED_WITNESS':
      case 'TRANSPARENCY_GOSSIP_UNVERIFIED_SOURCE':
      case 'TRANSPARENCY_GOSSIP_RELAY_UNVERIFIED':
      case 'TRANSPARENCY_GOSSIP_RELAY_HOP_INVALID':
      case 'TRANSPARENCY_CHECKPOINT_SIGNATURE_INVALID':
      case 'CHECKPOINT_NOTE_KEY_HINT_MISMATCH':
      case 'CHECKPOINT_COSIGNATURE_INVALID':
      case 'TRANSPARENCY_CHECKPOINT_REGRESSION':
      case 'TRANSPARENCY_CONSISTENCY_PROOF_REQUIRED':
      case 'TRANSPARENCY_CONSISTENCY_PROOF_INVALID':
        return new ApiError(err.code, 409, err.message);
      default:
        return new ApiError(err.code, 500, err.message);
    }
  }
  if (err instanceof ApiError) return err;
  return new ApiError('INTERNAL_ERROR', 500, 'Internal error.');
}
