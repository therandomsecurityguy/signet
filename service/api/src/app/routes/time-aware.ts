import type { Context } from 'hono';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { createRoute } from '@hono/zod-openapi';
import { z } from 'zod';

import type { AuditPublisher } from '../../application/ports/audit-publisher.js';
import type { TimeAwareRegistryUseCase } from '../../application/usecases/time-aware-registry.js';
import { ApiError } from '../../domain/errors/api-error.js';
import {
  commitUrn,
  refUrn,
  retentionRootUrn,
  tagUrn,
  workspaceUrn,
} from '../../../../registry/domain/together/db/graph/freeform/registry/urn.js';
import { TimeAwareRegistryError } from '../../../../registry/application/time-aware/errors/time-aware-registry-error.js';
import {
  TimeAwareBaseCommitFilterSchema,
  TimeAwareCommitDetailsSchema,
  TimeAwareCommitFilterSchema,
  TimeAwareGcPlanPreviewSchema,
  TimeAwareRefDetailsSchema,
  TimeAwareRetentionRootAnalysisSchema,
  TimeAwareTagDetailsSchema,
  TimeAwareTemporalQuerySchema,
  TimeAwareWorkspaceDetailsSchema,
} from '../../contracts/time-aware/common.js';
import {
  CreateDraftWorkspaceFromRefInputSchema,
  CreateDraftWorkspaceFromRefOutputSchema,
  ListWorkspacesOutputSchema,
} from '../../contracts/time-aware/workspaces.js';
import {
  CreateGcJobInputSchema,
  CreateGcJobOutputSchema,
  ExecuteGcJobInputSchema,
} from '../../contracts/time-aware/gc-jobs.js';
import { ErrorResponseSchema } from '../../contracts/error.js';
import type { AppEnv } from '../server.js';
import { auditApiWrite } from './audit.js';

const listCommitsRoute = createRoute({
  method: 'get',
  path: '/v1/time-aware/commits',
  request: { query: TimeAwareTemporalQuerySchema },
  responses: {
    200: { content: { 'application/json': { schema: z.any() } }, description: 'List commits' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid commit query parameters' },
  },
});

const getCommitRoute = createRoute({
  method: 'get',
  path: '/v1/time-aware/commits/{commitId}',
  request: {
    params: z.object({ commitId: z.string() }),
    query: TimeAwareTemporalQuerySchema,
  },
  responses: {
    200: { content: { 'application/json': { schema: TimeAwareCommitDetailsSchema } }, description: 'Get commit details' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid commit id' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Commit not found' },
  },
});

const listRefsRoute = createRoute({
  method: 'get',
  path: '/v1/time-aware/refs',
  request: { query: TimeAwareCommitFilterSchema },
  responses: {
    200: { content: { 'application/json': { schema: z.any() } }, description: 'List refs' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid ref query parameters' },
  },
});

const getRefRoute = createRoute({
  method: 'get',
  path: '/v1/time-aware/refs/{refName}',
  request: { params: z.object({ refName: z.string() }) },
  responses: {
    200: { content: { 'application/json': { schema: TimeAwareRefDetailsSchema } }, description: 'Get ref details' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid ref name' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Ref not found' },
  },
});

const listTagsRoute = createRoute({
  method: 'get',
  path: '/v1/time-aware/tags',
  request: { query: TimeAwareCommitFilterSchema },
  responses: {
    200: { content: { 'application/json': { schema: z.any() } }, description: 'List tags' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid tag query parameters' },
  },
});

const getTagRoute = createRoute({
  method: 'get',
  path: '/v1/time-aware/tags/{tagName}',
  request: { params: z.object({ tagName: z.string() }) },
  responses: {
    200: { content: { 'application/json': { schema: TimeAwareTagDetailsSchema } }, description: 'Get tag details' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid tag name' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Tag not found' },
  },
});

const listWorkspacesRoute = createRoute({
  method: 'get',
  path: '/v1/time-aware/workspaces',
  request: { query: TimeAwareBaseCommitFilterSchema },
  responses: {
    200: { content: { 'application/json': { schema: ListWorkspacesOutputSchema } }, description: 'List workspaces' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid workspace query parameters' },
  },
});

const getWorkspaceRoute = createRoute({
  method: 'get',
  path: '/v1/time-aware/workspaces/{workspaceId}',
  request: { params: z.object({ workspaceId: z.string() }) },
  responses: {
    200: { content: { 'application/json': { schema: TimeAwareWorkspaceDetailsSchema } }, description: 'Get workspace details' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid workspace id' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Workspace not found' },
  },
});

const listManifestsRoute = createRoute({
  method: 'get',
  path: '/v1/time-aware/manifests',
  responses: {
    200: { content: { 'application/json': { schema: z.any() } }, description: 'List artifact manifests' },
  },
});

const listRetentionRootsRoute = createRoute({
  method: 'get',
  path: '/v1/time-aware/retention-roots',
  responses: {
    200: { content: { 'application/json': { schema: z.any() } }, description: 'List retention roots' },
  },
});

const analyzeRetentionRootRoute = createRoute({
  method: 'get',
  path: '/v1/time-aware/retention-roots/{rootId}/analysis',
  request: {
    params: z.object({ rootId: z.string() }),
    query: TimeAwareTemporalQuerySchema,
  },
  responses: {
    200: { content: { 'application/json': { schema: TimeAwareRetentionRootAnalysisSchema } }, description: 'Analyze retention root' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid retention root id' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Retention root not found' },
  },
});

const gcPlanRoute = createRoute({
  method: 'get',
  path: '/v1/time-aware/retention-roots/{rootId}/gc-plan',
  request: {
    params: z.object({ rootId: z.string() }),
    query: TimeAwareTemporalQuerySchema,
  },
  responses: {
    200: { content: { 'application/json': { schema: TimeAwareGcPlanPreviewSchema } }, description: 'Preview GC plan' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid GC plan query parameters' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Retention root not found' },
  },
});

const listGcJobsRoute = createRoute({
  method: 'get',
  path: '/v1/time-aware/gc-jobs',
  responses: {
    200: { content: { 'application/json': { schema: z.any() } }, description: 'List GC jobs' },
  },
});

const createGcJobRoute = createRoute({
  method: 'post',
  path: '/v1/time-aware/gc-jobs',
  request: { body: { content: { 'application/json': { schema: CreateGcJobInputSchema } } } },
  responses: {
    200: { content: { 'application/json': { schema: CreateGcJobOutputSchema } }, description: 'GC job already exists (idempotent)' },
    201: { content: { 'application/json': { schema: CreateGcJobOutputSchema } }, description: 'GC job created' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid GC job payload' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Not found' },
    409: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Conflict' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Internal error' },
  },
});

const executeGcJobRoute = createRoute({
  method: 'post',
  path: '/v1/time-aware/gc-jobs/{jobId}/execute',
  request: {
    params: z.object({ jobId: z.string() }),
    body: { content: { 'application/json': { schema: ExecuteGcJobInputSchema } } },
  },
  responses: {
    200: { content: { 'application/json': { schema: z.any() } }, description: 'GC job executed' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid GC job execute payload' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Not found' },
    409: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Conflict' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Internal error' },
  },
});

const createDraftWorkspaceRoute = createRoute({
  method: 'post',
  path: '/v1/time-aware/refs/{refName}/workspaces/{workspaceId}/draft',
  request: {
    params: z.object({ refName: z.string(), workspaceId: z.string() }),
    body: { content: { 'application/json': { schema: CreateDraftWorkspaceFromRefInputSchema } } },
  },
  responses: {
    200: { content: { 'application/json': { schema: CreateDraftWorkspaceFromRefOutputSchema } }, description: 'Workspace draft already exists (idempotent)' },
    201: { content: { 'application/json': { schema: CreateDraftWorkspaceFromRefOutputSchema } }, description: 'Workspace draft created' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid workspace draft payload' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Not found' },
    409: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Conflict' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Internal error' },
  },
});

export function registerTimeAwareRoutes(
  app: OpenAPIHono<AppEnv>,
  deps: {
    timeAware: TimeAwareRegistryUseCase;
    audit: AuditPublisher;
  },
) {
  app.openapi(listCommitsRoute, async (c) => {
    const parsed = TimeAwareTemporalQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid commit query parameters.' } }, 400);
    }

    return c.json(
      await deps.timeAware.listCommits(
        parsed.data.valid_at || parsed.data.transaction_as_of
          ? {
              ...(parsed.data.valid_at ? { valid_at: parsed.data.valid_at } : {}),
              ...(parsed.data.transaction_as_of ? { transaction_as_of: parsed.data.transaction_as_of } : {}),
            }
          : undefined,
      ),
      200,
    );
  });
  app.openapi(getCommitRoute, async (c) => {
    const commitId = c.req.param('commitId');
    const parsed = TimeAwareTemporalQuerySchema.safeParse(c.req.query());
    if (!commitId || !parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid commit id.' } }, 400);
    }

    const got = await deps.timeAware.getCommitDetails({
      commit_urn: commitUrn(commitId),
      ...(parsed.data.valid_at ? { valid_at: parsed.data.valid_at } : {}),
      ...(parsed.data.transaction_as_of ? { transaction_as_of: parsed.data.transaction_as_of } : {}),
    });
    if (!got) {
      return c.json({ error: { code: 'COMMIT_NOT_FOUND', message: 'Commit not found.' } }, 404);
    }

    return c.json(got, 200);
  });

  app.openapi(listRefsRoute, async (c) => {
    const parsed = TimeAwareCommitFilterSchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid ref query parameters.' } }, 400);
    }

    return c.json(
      await deps.timeAware.listRefs(toCommitFilter(parsed.data)),
      200,
    );
  });
  app.openapi(getRefRoute, async (c) => {
    const refName = c.req.param('refName');
    if (!refName) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid ref name.' } }, 400);
    }

    const got = await deps.timeAware.getRefDetails({ ref_urn: refUrn(refName) });
    if (!got) {
      return c.json({ error: { code: 'REF_NOT_FOUND', message: 'Ref not found.' } }, 404);
    }

    return c.json(got, 200);
  });

  app.openapi(listTagsRoute, async (c) => {
    const parsed = TimeAwareCommitFilterSchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid tag query parameters.' } }, 400);
    }

    return c.json(
      await deps.timeAware.listTags(toCommitFilter(parsed.data)),
      200,
    );
  });
  app.openapi(getTagRoute, async (c) => {
    const tagName = c.req.param('tagName');
    if (!tagName) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid tag name.' } }, 400);
    }

    const got = await deps.timeAware.getTagDetails({ tag_urn: tagUrn(tagName) });
    if (!got) {
      return c.json({ error: { code: 'TAG_NOT_FOUND', message: 'Tag not found.' } }, 404);
    }

    return c.json(got, 200);
  });

  app.openapi(listWorkspacesRoute, async (c) => {
    const parsed = TimeAwareBaseCommitFilterSchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid workspace query parameters.' } }, 400);
    }

    return c.json(
      await deps.timeAware.listWorkspaces(toBaseCommitFilter(parsed.data)),
      200,
    );
  });
  app.openapi(getWorkspaceRoute, async (c) => {
    const workspaceId = c.req.param('workspaceId');
    if (!workspaceId) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid workspace id.' } }, 400);
    }

    const got = await deps.timeAware.getWorkspaceDetails({ workspace_urn: workspaceUrn(workspaceId) });
    if (!got) {
      return c.json({ error: { code: 'WORKSPACE_NOT_FOUND', message: 'Workspace not found.' } }, 404);
    }

    return c.json(got, 200);
  });

  app.openapi(listManifestsRoute, async (c) => c.json(await deps.timeAware.listArtifactManifests(), 200));
  app.openapi(listRetentionRootsRoute, async (c) => c.json(await deps.timeAware.listRetentionRoots(), 200));
  app.openapi(analyzeRetentionRootRoute, async (c) => {
    const rootId = c.req.param('rootId');
    const parsed = TimeAwareTemporalQuerySchema.safeParse(c.req.query());
    if (!rootId || !parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid retention root id.' } }, 400);
    }

    const got = await deps.timeAware.analyzeRetentionRoot({
      retention_root_urn: retentionRootUrn(rootId),
      ...(parsed.data.valid_at ? { valid_at: parsed.data.valid_at } : {}),
      ...(parsed.data.transaction_as_of ? { transaction_as_of: parsed.data.transaction_as_of } : {}),
    });
    if (!got) {
      return c.json({ error: { code: 'RETENTION_ROOT_NOT_FOUND', message: 'Retention root not found.' } }, 404);
    }

    return c.json(got, 200);
  });
  app.openapi(gcPlanRoute, async (c) => {
    const rootId = c.req.param('rootId');
    const parsed = TimeAwareTemporalQuerySchema.safeParse(c.req.query());
    if (!rootId || !parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid GC plan query parameters.' } }, 400);
    }

    const got = await deps.timeAware.previewGcPlan({
      retention_root_urn: retentionRootUrn(rootId),
      ...(parsed.data.valid_at ? { valid_at: parsed.data.valid_at } : {}),
      ...(parsed.data.transaction_as_of ? { transaction_as_of: parsed.data.transaction_as_of } : {}),
    });
    if (!got) {
      return c.json({ error: { code: 'RETENTION_ROOT_NOT_FOUND', message: 'Retention root not found.' } }, 404);
    }

    return c.json(got, 200);
  });
  app.openapi(listGcJobsRoute, async (c) => c.json(await deps.timeAware.listGcJobs(), 200));

  app.openapi(createGcJobRoute, async (c) => {
    const raw = await parseJsonBody(c);
    const parsed = CreateGcJobInputSchema.safeParse(raw);
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
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid GC job payload.' } }, 400);
    }

    try {
      const created = await deps.timeAware.createGcJob({
        job_id: parsed.data.job_id,
        author: parsed.data.author,
        retention_root_urns: parsed.data.retention_root_ids.map((rootId) => retentionRootUrn(rootId)),
        ...(typeof parsed.data.grace_period_days === 'number' ? { grace_period_days: parsed.data.grace_period_days } : {}),
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

      return c.json({ gc_job: created.value, created: created.created }, created.created ? 201 : 200);
    } catch (err) {
      const apiError = toTimeAwareApiError(err);
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

  app.openapi(executeGcJobRoute, async (c) => {
    const raw = await parseJsonBody(c);
    const parsed = ExecuteGcJobInputSchema.safeParse(raw);
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
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid GC job execute payload.' } }, 400);
    }

    try {
      const job = await deps.timeAware.executeGcJob({ job_id: jobId, author: parsed.data.author });

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

      return c.json({ gc_job: job }, 200);
    } catch (err) {
      const apiError = toTimeAwareApiError(err);
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

  app.openapi(createDraftWorkspaceRoute, async (c) => {
    const raw = await parseJsonBody(c);
    const parsed = CreateDraftWorkspaceFromRefInputSchema.safeParse(raw);
    const principal = c.get('principal');
    const pathParts = c.req.path.split('/');
    const refName = c.req.param('refName') ?? pathParts[4];
    const workspaceId = c.req.param('workspaceId') ?? pathParts[6];

    if (!parsed.success || !refName || !workspaceId) {
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
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid workspace draft payload.' } }, 400);
    }

    try {
      const created = await deps.timeAware.createDraftWorkspaceFromRef({
        ref_name: refName,
        workspace_id: workspaceId,
        ...parsed.data,
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

      return c.json({ workspace: created.value, created: created.created }, created.created ? 201 : 200);
    } catch (err) {
      const apiError = toTimeAwareApiError(err);
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

function toTimeAwareApiError(err: unknown): ApiError {
  if (err instanceof TimeAwareRegistryError) {
    switch (err.code) {
      case 'REF_NOT_FOUND':
        return new ApiError(err.code, 404, err.message);
      case 'REF_TARGET_NOT_FOUND':
        return new ApiError(err.code, 409, err.message);
      default:
        if (err.code.endsWith('_NOT_FOUND')) {
          return new ApiError(err.code, 404, err.message);
        }
        if (err.code.endsWith('_CONFLICT')) {
          return new ApiError(err.code, 409, err.message);
        }
        if (err.code.endsWith('_FAILED')) {
          return new ApiError(err.code, 500, err.message);
        }
        return new ApiError(err.code, 500, err.message);
    }
  }

  if (err instanceof ApiError) return err;
  return new ApiError('INTERNAL_ERROR', 500, 'Internal error.');
}

function toCommitFilter(input: {
  commit_urn?: string | undefined;
  valid_at?: string | undefined;
  transaction_as_of?: string | undefined;
}): { commit_urn?: string; valid_at?: string; transaction_as_of?: string } | undefined {
  if (!input.commit_urn && !input.valid_at && !input.transaction_as_of) {
    return undefined;
  }

  const out: { commit_urn?: string; valid_at?: string; transaction_as_of?: string } = {};
  if (input.commit_urn) out.commit_urn = input.commit_urn;
  if (input.valid_at) out.valid_at = input.valid_at;
  if (input.transaction_as_of) out.transaction_as_of = input.transaction_as_of;
  return out;
}

function toBaseCommitFilter(input: {
  base_commit_urn?: string | undefined;
  valid_at?: string | undefined;
  transaction_as_of?: string | undefined;
}): { base_commit_urn?: string; valid_at?: string; transaction_as_of?: string } | undefined {
  if (!input.base_commit_urn && !input.valid_at && !input.transaction_as_of) {
    return undefined;
  }

  const out: { base_commit_urn?: string; valid_at?: string; transaction_as_of?: string } = {};
  if (input.base_commit_urn) out.base_commit_urn = input.base_commit_urn;
  if (input.valid_at) out.valid_at = input.valid_at;
  if (input.transaction_as_of) out.transaction_as_of = input.transaction_as_of;
  return out;
}
