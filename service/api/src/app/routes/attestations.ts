import type { OpenAPIHono } from '@hono/zod-openapi';
import { createRoute } from '@hono/zod-openapi';
import { z } from 'zod';

import { RegistryCoreError } from '../../../../registry/application/errors/registry-core-error.js';
import type { AuditPublisher } from '../../application/ports/audit-publisher.js';
import type { AgentPublicationUseCase } from '../../application/usecases/agent-publication.js';
import type { SkillLifecycleUseCase } from '../../application/usecases/skill-lifecycle.js';
import { ErrorResponseSchema } from '../../contracts/error.js';
import {
  AttestationRecordSchema,
  CreateAttestationInputSchema,
  ListAttestationsOutputSchema,
} from '../../contracts/publication/attestations.js';
import type { AppEnv } from '../server.js';
import { auditApiWrite } from './audit.js';
import { entityKeySchema } from '../../contracts/keys.js';

const versionParamsSchema = z.object({ version: z.string() });

const createAttestationRoute = createRoute({
  method: 'post',
  path: '/v1/attestations',
  request: {
    body: { content: { 'application/json': { schema: CreateAttestationInputSchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: z.object({ attestation: AttestationRecordSchema }) } },
      description: 'Attestation verified and attached',
    },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid attestation payload' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Publication version not found' },
    409: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Attestation rejected' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Internal error' },
  },
});

const getSkillAttestationsRoute = createRoute({
  method: 'get',
  path: '/v1/skills/{skillKey}/versions/{version}/attestations',
  request: { params: versionParamsSchema.extend({ skillKey: entityKeySchema }) },
  responses: {
    200: { content: { 'application/json': { schema: ListAttestationsOutputSchema } }, description: 'Publication attestations' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid attestation request' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Skill version not found' },
  },
});

const getAgentAttestationsRoute = createRoute({
  method: 'get',
  path: '/v1/agents/{agentKey}/versions/{version}/attestations',
  request: { params: versionParamsSchema.extend({ agentKey: entityKeySchema }) },
  responses: {
    200: { content: { 'application/json': { schema: ListAttestationsOutputSchema } }, description: 'Publication attestations' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid attestation request' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Agent version not found' },
  },
});

export function registerAttestationRoutes(
  app: OpenAPIHono<AppEnv>,
  deps: {
    skills: SkillLifecycleUseCase;
    agents: AgentPublicationUseCase;
    audit: AuditPublisher;
  },
) {
  app.openapi(createAttestationRoute, async (c) => {
    const raw = await c.req.json().catch(() => undefined);
    const parsed = CreateAttestationInputSchema.safeParse(raw);
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
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid attestation payload.' } }, 400);
    }

    try {
      // Attachments are entity-agnostic (the publication URN carries the
      // entity type); the skill use case is used as the shared seam.
      const attached = await deps.skills.attachAttestation(parsed.data);
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
          policy_reason: 'attestation_attached',
        });
      }
      return c.json({ attestation: attached.attestation }, 200);
    } catch (err) {
      const mapped = toAttestationApiError(err);
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
          policy_reason: 'attestation_rejected',
          error_code: mapped.code,
        });
      }
      return c.json({ error: { code: mapped.code, message: mapped.message } }, mapped.status);
    }
  });

  app.openapi(getSkillAttestationsRoute, async (c) => {
    const skillKey = c.req.param('skillKey');
    const version = parseVersion(c.req.param('version'));
    if (!skillKey || !version) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid attestation request.' } }, 400);
    }
    const got = await deps.skills.listAttestations({ skill_key: skillKey, version });
    if (!got) {
      return c.json({ error: { code: 'SKILL_VERSION_NOT_FOUND', message: 'Skill version not found.' } }, 404);
    }
    return c.json(got, 200);
  });

  app.openapi(getAgentAttestationsRoute, async (c) => {
    const agentKey = c.req.param('agentKey');
    const version = parseVersion(c.req.param('version'));
    if (!agentKey || !version) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid attestation request.' } }, 400);
    }
    const got = await deps.agents.listAttestations({ agent_key: agentKey, version });
    if (!got) {
      return c.json({ error: { code: 'AGENT_VERSION_NOT_FOUND', message: 'Agent version not found.' } }, 404);
    }
    return c.json(got, 200);
  });
}

function parseVersion(raw: string | undefined): number | null {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function toAttestationApiError(err: unknown): { status: 404 | 409 | 500; code: string; message: string } {
  if (err instanceof RegistryCoreError) {
    switch (err.code) {
      case 'ATTESTATION_PUBLICATION_NOT_FOUND':
        return { status: 404, code: err.code, message: err.message };
      case 'ATTESTATION_CONFLICT':
      case 'ATTESTATION_TRUSTED_KEY_NOT_FOUND':
      case 'ATTESTATION_SIGNATURE_INVALID':
      case 'ATTESTATION_PAYLOAD_INVALID':
      case 'ATTESTATION_PREDICATE_TYPE_REQUIRED':
      case 'ATTESTATION_SUBJECT_MISMATCH':
        return { status: 409, code: err.code, message: err.message };
      default:
        return { status: 500, code: err.code, message: err.message };
    }
  }
  return { status: 500, code: 'INTERNAL_ERROR', message: 'Internal error.' };
}
