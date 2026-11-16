import type { Context } from 'hono';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { createRoute } from '@hono/zod-openapi';
import { z } from 'zod';

import type { AuditPublisher } from '../../application/ports/audit-publisher.js';
import type { AgentPublicationUseCase } from '../../application/usecases/agent-publication.js';
import { ApiError } from '../../domain/errors/api-error.js';
import { RegistryCoreError } from '../../../../registry/application/errors/registry-core-error.js';
import {
  CreateDetachedSignatureInputSchema,
  DetachedSignatureRecordSchema,
  PublicationEnvelopeSchema,
  PublicationVerificationSchema,
} from '../../contracts/publication/envelope.js';
import { ErrorResponseSchema } from '../../contracts/error.js';
import { ProvenanceJsonLdSchema, ProvenanceOutputSchema } from '../../contracts/provenance.js';
import { projectProvenanceToJsonLd } from '../../../../registry/application/services/provenance-export.js';
import type { AppEnv } from '../server.js';
import { auditApiWrite } from './audit.js';
import { entityKeySchema } from '../../contracts/keys.js';

const listAgentVersionsRoute = createRoute({
  method: 'get',
  path: '/v1/agents/{agentKey}/versions',
  request: { params: z.object({ agentKey: entityKeySchema }) },
  responses: {
    200: { content: { 'application/json': { schema: z.any() } }, description: 'List agent versions' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid agent key' },
  },
});

const getActiveAgentVersionRoute = createRoute({
  method: 'get',
  path: '/v1/agents/{agentKey}/active',
  request: { params: z.object({ agentKey: entityKeySchema }) },
  responses: {
    200: { content: { 'application/json': { schema: z.any() } }, description: 'Get active agent version' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid agent key' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Active agent version not found' },
  },
});

const getAgentPublicationEnvelopeRoute = createRoute({
  method: 'get',
  path: '/v1/agents/{agentKey}/versions/{version}/publication-envelope',
  request: { params: z.object({ agentKey: entityKeySchema, version: z.string() }) },
  responses: {
    200: { content: { 'application/json': { schema: PublicationEnvelopeSchema } }, description: 'Get agent publication envelope' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid agent publication request' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Agent version not found' },
  },
});

const getAgentPublicationVerificationRoute = createRoute({
  method: 'get',
  path: '/v1/agents/{agentKey}/versions/{version}/verification',
  request: { params: z.object({ agentKey: entityKeySchema, version: z.string() }) },
  responses: {
    200: { content: { 'application/json': { schema: PublicationVerificationSchema } }, description: 'Get agent publication verification' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid agent verification request' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Agent version not found' },
  },
});

const getAgentProvenanceRoute = createRoute({
  method: 'get',
  path: '/v1/agents/{agentKey}/versions/{version}/provenance',
  request: {
    params: z.object({ agentKey: entityKeySchema, version: z.string() }),
    query: z.object({ format: z.enum(['structured', 'jsonld']).optional() }),
  },
  responses: {
    200: {
      content: {
        'application/json': { schema: z.union([ProvenanceJsonLdSchema, ProvenanceOutputSchema]) },
      },
      description:
        'Get agent version provenance: structured view by default; PROV-O JSON-LD document with ?format=jsonld (derived from the same canonical triple list)',
    },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid provenance request' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Agent version not found' },
  },
});

const createAgentDetachedSignatureRoute = createRoute({
  method: 'post',
  path: '/v1/agents/{agentKey}/versions/{version}/signatures',
  request: {
    params: z.object({ agentKey: entityKeySchema, version: z.string() }),
    body: { content: { 'application/json': { schema: CreateDetachedSignatureInputSchema } } },
  },
  responses: {
    200: { content: { 'application/json': { schema: DetachedSignatureRecordSchema } }, description: 'Agent detached signature created' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid agent detached signature payload' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Agent version not found' },
    409: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Agent signature conflict' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Internal error' },
  },
});

export function registerAgentPublicationRoutes(
  app: OpenAPIHono<AppEnv>,
  deps: {
    publication: AgentPublicationUseCase;
    audit: AuditPublisher;
  },
) {
  app.openapi(listAgentVersionsRoute, async (c) => {
    const agentKey = c.req.param('agentKey');
    if (!agentKey) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid agent key.' } }, 400);
    }
    const body = await deps.publication.listVersions({ agent_key: agentKey });
    return c.json(body, 200);
  });

  app.openapi(getActiveAgentVersionRoute, async (c) => {
    const agentKey = c.req.param('agentKey');
    if (!agentKey) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid agent key.' } }, 400);
    }
    const got = await deps.publication.getActive({ agent_key: agentKey });
    if (!got) {
      return c.json({ error: { code: 'AGENT_ACTIVE_VERSION_NOT_FOUND', message: 'Active agent version not found.' } }, 404);
    }
    return c.json(got, 200);
  });

  app.openapi(getAgentPublicationEnvelopeRoute, async (c) => {
    const agentKey = c.req.param('agentKey');
    const version = parseVersion(c.req.param('version'));
    if (!agentKey || !version) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid agent publication request.' } }, 400);
    }
    const got = await deps.publication.getPublicationEnvelope({ agent_key: agentKey, version });
    if (!got) {
      return c.json({ error: { code: 'AGENT_VERSION_NOT_FOUND', message: 'Agent version not found.' } }, 404);
    }
    return c.json(got, 200);
  });

  app.openapi(getAgentPublicationVerificationRoute, async (c) => {
    const agentKey = c.req.param('agentKey');
    const version = parseVersion(c.req.param('version'));
    if (!agentKey || !version) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid agent verification request.' } }, 400);
    }
    const got = await deps.publication.getPublicationVerification({ agent_key: agentKey, version });
    if (!got) {
      return c.json({ error: { code: 'AGENT_VERSION_NOT_FOUND', message: 'Agent version not found.' } }, 404);
    }
    return c.json(got, 200);
  });

  app.openapi(getAgentProvenanceRoute, async (c) => {
    const agentKey = c.req.param('agentKey');
    const version = parseVersion(c.req.param('version'));
    if (!agentKey || !version) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid provenance request.' } }, 400);
    }
    const got = await deps.publication.getProvenance({ agent_key: agentKey, version });
    if (!got) {
      return c.json({ error: { code: 'AGENT_VERSION_NOT_FOUND', message: 'Agent version not found.' } }, 404);
    }
    if (c.req.valid('query').format === 'jsonld') {
      return c.json(projectProvenanceToJsonLd(got), 200);
    }
    return c.json(got, 200);
  });

  app.openapi(createAgentDetachedSignatureRoute, async (c) => {
    const raw = await c.req.json().catch(() => undefined);
    const parsed = CreateDetachedSignatureInputSchema.safeParse(raw);
    const agentKey = c.req.param('agentKey');
    const version = parseVersion(c.req.param('version'));
    return await handlePublicationWrite({
      c,
      deps,
      raw,
      parsedSuccess: parsed.success && Boolean(agentKey) && Boolean(version),
      parsedData:
        parsed.success && agentKey && version
          ? { agent_key: agentKey, version, ...parsed.data }
          : undefined,
      action: async (data) =>
        await deps.publication.createDetachedSignature({
          agent_key: data.agent_key,
          version: data.version,
          signer: data.signer,
          ...(data.key_ref ? { key_ref: data.key_ref } : {}),
          ...(data.algorithm ? { algorithm: data.algorithm } : {}),
          ...(data.signature ? { signature: data.signature } : {}),
          ...(data.keyless_bundle ? { keyless_bundle: data.keyless_bundle } : {}),
          ...(data.signed_payload ? { signed_payload: data.signed_payload } : {}),
          ...(data.transparency_log_ref ? { transparency_log_ref: data.transparency_log_ref } : {}),
          ...(data.inclusion_proof_ref ? { inclusion_proof_ref: data.inclusion_proof_ref } : {}),
          ...(data.inclusion_proof
            ? {
                inclusion_proof: {
                  log_id: data.inclusion_proof.log_id,
                  tree_size: data.inclusion_proof.tree_size,
                  leaf_index: data.inclusion_proof.leaf_index,
                  root_hash: data.inclusion_proof.root_hash,
                  proof_hashes: data.inclusion_proof.proof_hashes,
                  checkpoint_body: data.inclusion_proof.checkpoint_body,
                  checkpoint_signature: data.inclusion_proof.checkpoint_signature,
                  ...(data.inclusion_proof.transparency_log_ref
                    ? { transparency_log_ref: data.inclusion_proof.transparency_log_ref }
                    : {}),
                },
              }
            : {}),
        }),
      validationMessage: 'Invalid agent detached signature payload.',
    });
  });
}

function parseVersion(raw: string | undefined) {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
}

async function handlePublicationWrite<TInput extends Record<string, unknown>, TResult>(input: {
  c: Context<AppEnv>;
  deps: { publication: AgentPublicationUseCase; audit: AuditPublisher };
  raw: unknown;
  parsedSuccess: boolean;
  parsedData: TInput | undefined;
  action: (data: TInput) => Promise<TResult>;
  validationMessage: string;
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
        method: 'POST',
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
        method: 'POST',
        raw_input: input.parsedData,
        policy_effect: 'allow',
        policy_reason: 'operation_completed',
      });
    }
    return input.c.json(result, 200);
  } catch (err) {
    const mapped = mapAgentPublicationError(err);
    if (principal) {
      await auditApiWrite({
        audit: input.deps.audit,
        request_id: input.c.get('requestId'),
        client_name: input.c.req.header('X-Agent-Client') ?? 'unknown',
        principal,
        path: input.c.req.path,
        method: 'POST',
        raw_input: input.parsedData,
        policy_effect: 'deny',
        policy_reason: mapped.code,
        error_code: mapped.code,
      });
    }
    return input.c.json({ error: { code: mapped.code, message: mapped.message } }, mapped.httpStatus as 400 | 404 | 409 | 500);
  }
}

function mapAgentPublicationError(err: unknown) {
  if (err instanceof RegistryCoreError) {
    switch (err.code) {
      case 'AGENT_VERSION_NOT_FOUND':
        return new ApiError(err.code, 404, err.message);
      default:
        if (err.code.startsWith('AGENT_SIGNATURE_')) {
          return new ApiError(err.code, 409, err.message);
        }
        return new ApiError(err.code, 500, err.message);
    }
  }
  if (err instanceof ApiError) return err;
  return new ApiError('INTERNAL_ERROR', 500, 'Internal error.');
}
