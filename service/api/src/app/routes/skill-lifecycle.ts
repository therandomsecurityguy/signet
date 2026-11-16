import type { Context } from 'hono';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { createRoute } from '@hono/zod-openapi';
import { z } from 'zod';

import type { AuditPublisher } from '../../application/ports/audit-publisher.js';
import type { SkillLifecycleUseCase } from '../../application/usecases/skill-lifecycle.js';
import { ApiError } from '../../domain/errors/api-error.js';
import { RegistryCoreError } from '../../../../registry/application/errors/registry-core-error.js';
import {
  ActiveSkillVersionOutputSchema,
  CreateSkillDraftInputSchema,
  ListSkillVersionsOutputSchema,
  ReviewVersionInputSchema,
  SkillLifecycleOperationResultSchema,
  SkillVersionDetailsSchema,
  SkillVersionOperationInputSchema,
} from '../../contracts/skills/lifecycle.js';
import { ErrorResponseSchema } from '../../contracts/error.js';
import { ProvenanceJsonLdSchema, ProvenanceOutputSchema } from '../../contracts/provenance.js';
import { projectProvenanceToJsonLd } from '../../../../registry/application/services/provenance-export.js';
import {
  CreateDetachedSignatureInputSchema,
  PreparedPublicationSchema,
  PublicationEnvelopeSchema,
  PublicationVerificationSchema,
} from '../../contracts/publication/envelope.js';
import type { AppEnv } from '../server.js';
import { auditApiWrite } from './audit.js';
import { entityKeySchema } from '../../contracts/keys.js';

const listVersionsRoute = createRoute({
  method: 'get',
  path: '/v1/skills/{skillKey}/versions',
  request: { params: z.object({ skillKey: entityKeySchema }) },
  responses: {
    200: { content: { 'application/json': { schema: ListSkillVersionsOutputSchema } }, description: 'List skill versions' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid skill key' },
  },
});

const getVersionRoute = createRoute({
  method: 'get',
  path: '/v1/skills/{skillKey}/versions/{version}',
  request: { params: z.object({ skillKey: entityKeySchema, version: z.string() }) },
  responses: {
    200: { content: { 'application/json': { schema: SkillVersionDetailsSchema } }, description: 'Get skill version' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid version' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Skill version not found' },
  },
});

const getActiveVersionRoute = createRoute({
  method: 'get',
  path: '/v1/skills/{skillKey}/active',
  request: { params: z.object({ skillKey: entityKeySchema }) },
  responses: {
    200: { content: { 'application/json': { schema: ActiveSkillVersionOutputSchema } }, description: 'Get active skill version' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid skill key' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Active skill version not found' },
  },
});

const getPublicationEnvelopeRoute = createRoute({
  method: 'get',
  path: '/v1/skills/{skillKey}/versions/{version}/publication-envelope',
  request: { params: z.object({ skillKey: entityKeySchema, version: z.string() }) },
  responses: {
    200: { content: { 'application/json': { schema: PublicationEnvelopeSchema } }, description: 'Get publication envelope' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid publication envelope request' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Skill version not found' },
  },
});

const getPublicationVerificationRoute = createRoute({
  method: 'get',
  path: '/v1/skills/{skillKey}/versions/{version}/verification',
  request: { params: z.object({ skillKey: entityKeySchema, version: z.string() }) },
  responses: {
    200: { content: { 'application/json': { schema: PublicationVerificationSchema } }, description: 'Get publication verification' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid publication verification request' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Skill version not found' },
  },
});

const getProvenanceRoute = createRoute({
  method: 'get',
  path: '/v1/skills/{skillKey}/versions/{version}/provenance',
  request: {
    params: z.object({ skillKey: entityKeySchema, version: z.string() }),
    query: z.object({ format: z.enum(['structured', 'jsonld']).optional() }),
  },
  responses: {
    200: {
      content: {
        'application/json': { schema: z.union([ProvenanceJsonLdSchema, ProvenanceOutputSchema]) },
      },
      description:
        'Get provenance: structured view by default; PROV-O JSON-LD document with ?format=jsonld (derived from the same canonical triple list)',
    },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid provenance request' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Skill version not found' },
  },
});

const createDraftRoute = createRoute({
  method: 'post',
  path: '/v1/skills/{skillKey}/drafts',
  request: {
    params: z.object({ skillKey: entityKeySchema }),
    body: { content: { 'application/json': { schema: CreateSkillDraftInputSchema } } },
  },
  responses: {
    200: { content: { 'application/json': { schema: SkillLifecycleOperationResultSchema } }, description: 'Skill draft created' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid skill draft payload' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Skill not found' },
    409: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Skill conflict' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Internal error' },
  },
});

const validateVersionRoute = createRoute({
  method: 'post',
  path: '/v1/skills/{skillKey}/versions/{version}/validate',
  request: {
    params: z.object({ skillKey: entityKeySchema, version: z.string() }),
    body: { content: { 'application/json': { schema: SkillVersionOperationInputSchema } } },
  },
  responses: {
    200: { content: { 'application/json': { schema: SkillLifecycleOperationResultSchema } }, description: 'Skill version validated' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid skill version operation payload' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Skill version not found' },
    409: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Skill version conflict' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Internal error' },
  },
});

const publishVersionRoute = createRoute({
  method: 'post',
  path: '/v1/skills/{skillKey}/versions/{version}/publish',
  request: {
    params: z.object({ skillKey: entityKeySchema, version: z.string() }),
    body: { content: { 'application/json': { schema: SkillVersionOperationInputSchema } } },
  },
  responses: {
    200: { content: { 'application/json': { schema: SkillLifecycleOperationResultSchema } }, description: 'Skill version published' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid skill version operation payload' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Skill version not found' },
    409: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Skill version conflict' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Internal error' },
  },
});

const preparePublicationRoute = createRoute({
  method: 'post',
  path: '/v1/skills/{skillKey}/versions/{version}/prepare-publication',
  request: {
    params: z.object({ skillKey: entityKeySchema, version: z.string() }),
    body: { content: { 'application/json': { schema: SkillVersionOperationInputSchema } } },
  },
  responses: {
    200: { content: { 'application/json': { schema: PreparedPublicationSchema } }, description: 'Publication candidate prepared for signing' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid skill version operation payload' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Skill version not found' },
    409: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Skill version conflict' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Internal error' },
  },
});

const promoteVersionRoute = createRoute({
  method: 'post',
  path: '/v1/skills/{skillKey}/versions/{version}/promote',
  request: {
    params: z.object({ skillKey: entityKeySchema, version: z.string() }),
    body: { content: { 'application/json': { schema: SkillVersionOperationInputSchema } } },
  },
  responses: {
    200: { content: { 'application/json': { schema: SkillLifecycleOperationResultSchema } }, description: 'Skill version promoted' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid skill version operation payload' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Skill version not found' },
    409: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Skill version conflict' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Internal error' },
  },
});

const deprecateVersionRoute = createRoute({
  method: 'post',
  path: '/v1/skills/{skillKey}/versions/{version}/deprecate',
  request: {
    params: z.object({ skillKey: entityKeySchema, version: z.string() }),
    body: { content: { 'application/json': { schema: SkillVersionOperationInputSchema } } },
  },
  responses: {
    200: { content: { 'application/json': { schema: SkillLifecycleOperationResultSchema } }, description: 'Skill version deprecated' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid skill version operation payload' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Skill version not found' },
    409: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Skill version conflict' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Internal error' },
  },
});

const certifyVersionRoute = createRoute({
  method: 'post',
  path: '/v1/skills/{skillKey}/versions/{version}/certify',
  request: {
    params: z.object({ skillKey: entityKeySchema, version: z.string() }),
    body: { content: { 'application/json': { schema: SkillVersionOperationInputSchema } } },
  },
  responses: {
    200: { content: { 'application/json': { schema: SkillLifecycleOperationResultSchema } }, description: 'Skill version certified' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid skill version operation payload' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Skill version not found' },
    409: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Skill version conflict' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Internal error' },
  },
});

const revokeVersionRoute = createRoute({
  method: 'post',
  path: '/v1/skills/{skillKey}/versions/{version}/revoke',
  request: {
    params: z.object({ skillKey: entityKeySchema, version: z.string() }),
    body: { content: { 'application/json': { schema: SkillVersionOperationInputSchema } } },
  },
  responses: {
    200: { content: { 'application/json': { schema: SkillLifecycleOperationResultSchema } }, description: 'Skill version revoked' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid skill version operation payload' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Skill version not found' },
    409: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Skill version conflict' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Internal error' },
  },
});

const archiveVersionRoute = createRoute({
  method: 'post',
  path: '/v1/skills/{skillKey}/versions/{version}/archive',
  request: {
    params: z.object({ skillKey: entityKeySchema, version: z.string() }),
    body: { content: { 'application/json': { schema: SkillVersionOperationInputSchema } } },
  },
  responses: {
    200: { content: { 'application/json': { schema: SkillLifecycleOperationResultSchema } }, description: 'Skill version archived' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid skill version operation payload' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Skill version not found' },
    409: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Skill version conflict' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Internal error' },
  },
});

const reviewVersionRoute = createRoute({
  method: 'post',
  path: '/v1/skills/{skillKey}/versions/{version}/review',
  request: {
    params: z.object({ skillKey: entityKeySchema, version: z.string() }),
    body: { content: { 'application/json': { schema: ReviewVersionInputSchema } } },
  },
  responses: {
    200: { content: { 'application/json': { schema: SkillLifecycleOperationResultSchema } }, description: 'Skill version reviewed' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid review payload' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Skill version not found' },
    409: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Skill version conflict' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Internal error' },
  },
});

const createDetachedSignatureRoute = createRoute({
  method: 'post',
  path: '/v1/skills/{skillKey}/versions/{version}/signatures',
  request: {
    params: z.object({ skillKey: entityKeySchema, version: z.string() }),
    body: { content: { 'application/json': { schema: CreateDetachedSignatureInputSchema } } },
  },
  responses: {
    200: { content: { 'application/json': { schema: z.any() } }, description: 'Detached signature created' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid detached signature payload' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Skill version not found' },
    409: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Skill version conflict' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Internal error' },
  },
});

export function registerSkillLifecycleRoutes(
  app: OpenAPIHono<AppEnv>,
  deps: {
    lifecycle: SkillLifecycleUseCase;
    audit: AuditPublisher;
  },
) {
  app.openapi(listVersionsRoute, async (c) => {
    const skillKey = c.req.param('skillKey');
    if (!skillKey) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid skill key.' } }, 400);
    }
    const body = await deps.lifecycle.listVersions({ skill_key: skillKey });
    return c.json(body, 200);
  });

  app.openapi(getVersionRoute, async (c) => {
    const skillKey = c.req.param('skillKey');
    const version = parseVersion(c.req.param('version'));
    if (!skillKey || !version) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid version.' } }, 400);
    }
    const got = await deps.lifecycle.getVersion({ skill_key: skillKey, version });
    if (!got) {
      return c.json({ error: { code: 'SKILL_VERSION_NOT_FOUND', message: 'Skill version not found.' } }, 404);
    }
    return c.json(got, 200);
  });

  app.openapi(getActiveVersionRoute, async (c) => {
    const skillKey = c.req.param('skillKey');
    if (!skillKey) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid skill key.' } }, 400);
    }
    const got = await deps.lifecycle.getActive({ skill_key: skillKey });
    if (!got) {
      return c.json({ error: { code: 'SKILL_ACTIVE_VERSION_NOT_FOUND', message: 'Active skill version not found.' } }, 404);
    }
    return c.json(got, 200);
  });

  app.openapi(getPublicationEnvelopeRoute, async (c) => {
    const skillKey = c.req.param('skillKey');
    const version = parseVersion(c.req.param('version'));
    if (!skillKey || !version) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid publication envelope request.' } }, 400);
    }
    const got = await deps.lifecycle.getPublicationEnvelope({ skill_key: skillKey, version });
    if (!got) {
      return c.json({ error: { code: 'SKILL_VERSION_NOT_FOUND', message: 'Skill version not found.' } }, 404);
    }
    return c.json(got, 200);
  });

  app.openapi(getPublicationVerificationRoute, async (c) => {
    const skillKey = c.req.param('skillKey');
    const version = parseVersion(c.req.param('version'));
    if (!skillKey || !version) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid publication verification request.' } }, 400);
    }
    const got = await deps.lifecycle.getPublicationVerification({ skill_key: skillKey, version });
    if (!got) {
      return c.json({ error: { code: 'SKILL_VERSION_NOT_FOUND', message: 'Skill version not found.' } }, 404);
    }
    return c.json(got, 200);
  });

  app.openapi(getProvenanceRoute, async (c) => {
    const skillKey = c.req.param('skillKey');
    const version = parseVersion(c.req.param('version'));
    if (!skillKey || !version) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid provenance request.' } }, 400);
    }
    const got = await deps.lifecycle.getProvenance({ skill_key: skillKey, version });
    if (!got) {
      return c.json({ error: { code: 'SKILL_VERSION_NOT_FOUND', message: 'Skill version not found.' } }, 404);
    }
    if (c.req.valid('query').format === 'jsonld') {
      return c.json(projectProvenanceToJsonLd(got), 200);
    }
    return c.json(got, 200);
  });

  app.openapi(createDraftRoute, async (c) => {
    const raw = await c.req.json().catch(() => undefined);
    const parsed = CreateSkillDraftInputSchema.safeParse(raw);
    const skillKey = c.req.param('skillKey');
    return await handleLifecycleWrite({
      c,
      deps,
      raw,
      parsedSuccess: parsed.success && Boolean(skillKey),
      parsedData: parsed.success && skillKey ? { skill_key: skillKey, ...parsed.data } : undefined,
      action: async (data) => await deps.lifecycle.createDraft(data),
      validationMessage: 'Invalid skill draft payload.',
      method: 'POST',
    });
  });

app.openapi(validateVersionRoute, async (c) => {
    return await handleVersionAction({ c, deps, action: 'validate' });
  });

  app.openapi(publishVersionRoute, async (c) => {
    return await handleVersionAction({ c, deps, action: 'publish' });
  });

  app.openapi(preparePublicationRoute, async (c) => {
    const raw = await c.req.json().catch(() => undefined);
    const parsed = SkillVersionOperationInputSchema.safeParse(raw);
    const rawVersion = c.req.param('version');
    const version = rawVersion ? parseVersion(rawVersion) : null;
    const skillKey = c.req.param('skillKey');
    return await handleLifecycleWrite({
      c,
      deps,
      raw,
      parsedSuccess: parsed.success && Boolean(version) && Boolean(skillKey),
      parsedData:
        parsed.success && version && skillKey
          ? { skill_key: skillKey, version, ...parsed.data }
          : undefined,
      action: async (data) => await deps.lifecycle.preparePublication(data),
      validationMessage: 'Invalid skill version operation payload.',
      method: 'POST',
    });
  });

  app.openapi(promoteVersionRoute, async (c) => {
    return await handleVersionAction({ c, deps, action: 'promote' });
  });

  app.openapi(deprecateVersionRoute, async (c) => {
    return await handleVersionAction({ c, deps, action: 'deprecate' });
  });

  app.openapi(certifyVersionRoute, async (c) => {
    return await handleVersionAction({ c, deps, action: 'certify' });
  });

  app.openapi(revokeVersionRoute, async (c) => {
    return await handleVersionAction({ c, deps, action: 'revoke' });
  });

  app.openapi(archiveVersionRoute, async (c) => {
    return await handleVersionAction({ c, deps, action: 'archive' });
  });

  app.openapi(reviewVersionRoute, async (c) => {
    const raw = await c.req.json().catch(() => undefined);
    const parsed = ReviewVersionInputSchema.safeParse(raw);
    const rawVersion = c.req.param('version');
    const version = rawVersion ? parseVersion(rawVersion) : null;
    const skillKey = c.req.param('skillKey');
    return await handleLifecycleWrite({
      c,
      deps,
      raw,
      parsedSuccess: parsed.success && Boolean(version) && Boolean(skillKey),
      parsedData:
        parsed.success && version && skillKey
          ? { skill_key: skillKey, version, ...parsed.data }
          : undefined,
      action: async (data) => await deps.lifecycle.review(data),
      validationMessage: 'Invalid review payload.',
      method: 'POST',
    });
  });

  app.openapi(createDetachedSignatureRoute, async (c) => {
    const raw = await c.req.json().catch(() => undefined);
    const parsed = CreateDetachedSignatureInputSchema.safeParse(raw);
    const rawVersion = c.req.param('version');
    const version = rawVersion ? parseVersion(rawVersion) : null;
    const skillKey = c.req.param('skillKey');
    return await handleLifecycleWrite({
      c,
      deps,
      raw,
      parsedSuccess: parsed.success && Boolean(version) && Boolean(skillKey),
      parsedData:
        parsed.success && version && skillKey
          ? { skill_key: skillKey, version, ...parsed.data }
          : undefined,
      action: async (data) =>
        await deps.lifecycle.createDetachedSignature({
          skill_key: data.skill_key,
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
      validationMessage: 'Invalid detached signature payload.',
      method: 'POST',
    });
  });
}

async function handleVersionAction(input: {
  c: Context<AppEnv>;
  deps: { lifecycle: SkillLifecycleUseCase; audit: AuditPublisher };
  action: 'validate' | 'publish' | 'promote' | 'deprecate' | 'certify' | 'revoke' | 'archive';
}) {
  const raw = await input.c.req.json().catch(() => undefined);
  const parsed = SkillVersionOperationInputSchema.safeParse(raw);
  const rawVersion = input.c.req.param('version');
  const version = rawVersion ? parseVersion(rawVersion) : null;
  const skillKey = input.c.req.param('skillKey');

  return await handleLifecycleWrite({
    c: input.c,
    deps: input.deps,
    raw,
    parsedSuccess: parsed.success && Boolean(version) && Boolean(skillKey),
    parsedData:
      parsed.success && version && skillKey
        ? { skill_key: skillKey, version, ...parsed.data }
        : undefined,
    action: async (data) => await input.deps.lifecycle[input.action](data),
    validationMessage: 'Invalid skill version operation payload.',
    method: 'POST',
  });
}

async function handleLifecycleWrite<TInput extends Record<string, unknown>, TResult>(input: {
  c: Context<AppEnv>;
  deps: { lifecycle: SkillLifecycleUseCase; audit: AuditPublisher };
  raw: unknown;
  parsedSuccess: boolean;
  parsedData: TInput | undefined;
  action: (data: TInput) => Promise<TResult>;
  validationMessage: string;
  method: 'POST';
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
        method: input.method,
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
        method: input.method,
        raw_input: input.parsedData,
        policy_effect: 'allow',
        policy_reason: 'operation_completed',
      });
    }
    return input.c.json(result, 200);
  } catch (err) {
    const mapped = mapLifecycleError(err);
    if (principal) {
      await auditApiWrite({
        audit: input.deps.audit,
        request_id: input.c.get('requestId'),
        client_name: input.c.req.header('X-Agent-Client') ?? 'unknown',
        principal,
        path: input.c.req.path,
        method: input.method,
        raw_input: input.parsedData,
        policy_effect: 'deny',
        policy_reason: mapped.code,
        error_code: mapped.code,
      });
    }
    return input.c.json({ error: { code: mapped.code, message: mapped.message } }, mapped.httpStatus as 400 | 404 | 409 | 500);
  }
}

function parseVersion(raw: string): number | null {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function mapLifecycleError(err: unknown) {
  if (err instanceof RegistryCoreError) {
    switch (err.code) {
      case 'SKILL_VERSION_NOT_FOUND':
        return new ApiError(err.code, 404, err.message);
      case 'ONTOLOGY_PACKAGE_NOT_FOUND':
        return new ApiError(err.code, 404, err.message);
      case 'SKILL_VERSION_CREATE_FAILED':
        return new ApiError(err.code, 500, err.message);
      default:
        if (err.code.startsWith('SKILL_VERSION_')) {
          return new ApiError(err.code, 409, err.message);
        }
        return new ApiError(err.code, 500, err.message);
    }
  }
  if (err instanceof ApiError) return err;
  return new ApiError('INTERNAL_ERROR', 500, 'Internal error.');
}
