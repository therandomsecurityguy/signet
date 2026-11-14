import type { Logger } from 'pino';
import { OpenAPIHono } from '@hono/zod-openapi';
import { swaggerUI } from '@hono/swagger-ui';
import { cors } from 'hono/cors';
import { requestId } from 'hono/request-id';

import type { AppDependencies } from './dependencies.js';
import type { Principal } from '../domain/principal/principal.js';
import { logger as baseLogger } from '../infrastructure/logging/pino.js';
import {
  httpRequestDurationSeconds,
  httpRequestsTotal,
  registry,
} from '../infrastructure/telemetry/metrics.js';
import { registerAgentRoutes } from './routes/agents.js';
import { registerArtifactRoutes } from './routes/artifacts.js';
import { registerAdvisoryRoutes } from './routes/advisories.js';
import { registerAttestationRoutes } from './routes/attestations.js';
import { registerAgentLifecycleRoutes } from './routes/agent-lifecycle.js';
import { registerCompileRoutes } from './routes/compile.js';
import { registerReviewRoutes } from './routes/reviews.js';
import { registerGovernanceLogRoutes } from './routes/governance-log.js';
import { registerOntologyPackageRoutes } from './routes/ontology-packages.js';
import { registerPolicyPackageRoutes } from './routes/policy-packages.js';
import { registerAgentPublicationRoutes } from './routes/agent-publication.js';
import { registerApiKeyRoutes } from './routes/api-keys.js';
import { registerSkillRoutes } from './routes/skills.js';
import { registerSkillLifecycleRoutes } from './routes/skill-lifecycle.js';
import { registerTimeAwareRoutes } from './routes/time-aware.js';
import { registerGraphRoutes } from './routes/graph.js';
import { registerPublicKeyRoutes } from './routes/public-keys.js';
import { registerTransparencyLogRoutes } from './routes/transparency-logs.js';
import { buildAuthMiddleware, buildWriteAuthMiddleware, buildApiKeyPrincipalGuard, buildAdminAuth } from './middleware/auth.js';
import { buildRateLimitMiddleware } from './middleware/rate-limit.js';

const SECURITY_HEADERS = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'X-XSS-Protection': '1; mode=block',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; object-src 'none'",
};

export type AppEnv = {
  Variables: {
    requestId: string;
    logger: Logger;
    principal?: Principal;
  };
};

export function buildApp(deps: AppDependencies) {
const app = new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid request.' } }, 400);
      }
      return undefined;
    },
  });

  app.use('*', requestId());
  app.use('*', cors({
    origin: deps.env.CORS_ALLOWED_ORIGINS
      ? deps.env.CORS_ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
      : '*',
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-Agent-Client'],
  }));
  app.use('*', buildRateLimitMiddleware(deps.env));

  app.use('*', async (c, next) => {
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
      c.res.headers.set(key, value);
    }
    await next();
  });

  app.use('*', async (c, next) => {
    const requestLogger = baseLogger.child({
      request_id: c.get('requestId'),
      client_name: c.req.header('X-Agent-Client') ?? 'unknown',
    });
    c.set('logger', requestLogger);
    await next();
  });

  app.use('*', async (c, next) => {
    const start = Date.now();
    await next();
    const route = c.req.routePath ?? c.req.path;
    const labels = {
      method: c.req.method,
      route,
      status: String(c.res.status),
    };
    httpRequestsTotal.inc(labels);
    httpRequestDurationSeconds.observe(labels, (Date.now() - start) / 1000);
  });

  app.get('/healthz', (c) => c.json({ ok: true }));
  app.get('/readyz', (c) => c.json({ ok: true }));
  app.get('/metrics', async (c) => {
    c.header('content-type', registry.contentType);
    return c.body(await registry.metrics());
  });

  app.doc('/v1/openapi.json', {
    openapi: '3.1.0',
    info: {
      title: 'Signet Registry API',
      version: '1.0.0',
      description:
        'Programmatic management plane for the Signet agent/skill registry: lifecycle, certification, transparency, provenance, and time-aware operations.',
    },
    servers: [{ url: '/' }],
  });
  app.get('/v1/docs', swaggerUI({ url: '/v1/openapi.json' }));

  const writeAuth = buildWriteAuthMiddleware({
    env: deps.env,
    apiKeys: deps.apiKeys,
    audit: deps.audit,
  });
  const sessionAuth = buildAuthMiddleware({
    env: deps.env,
    apiKeys: deps.apiKeys,
    audit: deps.audit,
  });
  app.use('/v1/agents', writeAuth);
  app.use('/v1/agents/*', writeAuth);
  app.use('/v1/advisories', writeAuth);
  app.use('/v1/advisories/*', writeAuth);
  app.use('/v1/attestations', writeAuth);
  app.use('/v1/public-keys', writeAuth);
  app.use('/v1/public-keys/*', writeAuth);
  app.use('/v1/skills', writeAuth);
  app.use('/v1/skills/*', writeAuth);
  app.use('/v1/transparency-logs', writeAuth);
  app.use('/v1/transparency-logs/*', writeAuth);
  app.use('/v1/time-aware', writeAuth);
  app.use('/v1/time-aware/*', writeAuth);
  app.use('/v1/policy-packages', writeAuth);
  app.use('/v1/policy-packages/*', writeAuth);
  app.use('/v1/ontology-packages', writeAuth);
  app.use('/v1/ontology-packages/*', writeAuth);
  app.use('/v1/compile', writeAuth);
  app.use('/v1/compile/*', writeAuth);
  app.use('/v1/de-facto-terms', writeAuth);
  app.use('/v1/de-facto-terms/*', writeAuth);
  app.use('/v1/session', sessionAuth);
  // API-key management: Okta admin only; API keys cannot manage API keys.
  app.use('/v1/api-keys', buildApiKeyPrincipalGuard({ audit: deps.audit }));
  app.use('/v1/api-keys', buildAdminAuth({ env: deps.env, apiKeys: deps.apiKeys, audit: deps.audit }));
  app.use('/v1/api-keys/*', buildApiKeyPrincipalGuard({ audit: deps.audit }));
  app.use('/v1/api-keys/*', buildAdminAuth({ env: deps.env, apiKeys: deps.apiKeys, audit: deps.audit }));
  registerApiKeyRoutes(app, { apiKeys: deps.apiKeyManagement, audit: deps.audit });
  registerAgentRoutes(app, {
    listAgents: deps.listAgents,
    getAgent: deps.getAgent,
    createAgent: deps.createAgent,
    audit: deps.audit,
  });
  registerAgentPublicationRoutes(app, {
    publication: deps.agentPublication,
    audit: deps.audit,
  });
  registerAgentLifecycleRoutes(app, {
    lifecycle: deps.agentLifecycle,
    audit: deps.audit,
  });
  registerPolicyPackageRoutes(app, {
    policyPackages: deps.policyPackages,
    audit: deps.audit,
  });
  registerOntologyPackageRoutes(app, {
    ontologyPackages: deps.ontologyPackages,
    audit: deps.audit,
  });
  registerGovernanceLogRoutes(app, {
    governanceLog: deps.governanceLog,
  });
  registerCompileRoutes(app, {
    compile: deps.compile,
    deFactoTerms: deps.deFactoTerms,
    audit: deps.audit,
  });
  registerReviewRoutes(app, {
    reviews: deps.reviews,
  });
  registerPublicKeyRoutes(app, {
    listPublicKeys: deps.listPublicKeys,
    getPublicKey: deps.getPublicKey,
    createPublicKey: deps.createPublicKey,
    revokePublicKey: deps.revokePublicKey,
    audit: deps.audit,
  });
  registerTransparencyLogRoutes(app, {
    listTransparencyLogs: deps.listTransparencyLogs,
    getTransparencyLog: deps.getTransparencyLog,
    createTransparencyLog: deps.createTransparencyLog,
    createTransparencyObservation: deps.createTransparencyObservation,
    createTransparencyGossipEvent: deps.createTransparencyGossipEvent,
    createTransparencyWitness: deps.createTransparencyWitness,
    createTransparencyCheckpoint: deps.createTransparencyCheckpoint,
    getTransparencyLogTimeline: deps.getTransparencyLogTimeline,
    getTransparencyLogVerification: deps.getTransparencyLogVerification,
    reconcilePublicationTransparency: deps.reconcilePublicationTransparency,
    audit: deps.audit,
  });
  registerSkillRoutes(app, {
    listSkills: deps.listSkills,
    getSkill: deps.getSkill,
    createSkill: deps.createSkill,
    audit: deps.audit,
  });
  registerSkillLifecycleRoutes(app, {
    lifecycle: deps.skillLifecycle,
    audit: deps.audit,
  });
  registerAttestationRoutes(app, {
    skills: deps.skillLifecycle,
    agents: deps.agentPublication,
    audit: deps.audit,
  });
  registerAdvisoryRoutes(app, {
    advisories: deps.advisories,
    audit: deps.audit,
  });
  registerTimeAwareRoutes(app, {
    timeAware: deps.timeAwareRegistry,
    audit: deps.audit,
  });
  registerGraphRoutes(app, {
    readGraphSubgraph: deps.readGraphSubgraph,
  });
  registerArtifactRoutes(app, {
    registry: deps.registryCore,
  });

  app.get('/v1', (c) =>
    c.json({
      service: 'signet-api',
      status: 'agents-and-skills-metadata-slice',
      purpose: 'Programmatic CRUD and operational API for registry entities.',
      auth: {
        mode: deps.env.AUTH_MODE,
        okta_mode: deps.env.OKTA_MODE,
      },
      owns: [
        'Machine-to-machine registry operations',
        'Versioned HTTP contracts for registry entities',
        'Programmatic workflows for CICD, scanners, and CLIs',
      ],
      does_not_own: [
        'MCP protocol exposure',
        'Tool API execution against external data warehouses',
        'Registry graph/CAS storage implementation details',
      ],
      depends_on: ['service/registry'],
      adjacent_services: {
        mcp: 'tool-based agent access and MCP transport',
        registry: 'domain model, graph metadata, artifact storage, and ingestion seams',
      },
      next_steps: [
        'Extend from agent and skill metadata to wider entity CRUD',
        'Deepen route-level authorization beyond the current write guard',
        'Evolve from in-memory registry adapter to persistent graph-backed API flows',
      ],
      endpoints: [
        'GET /v1/agents',
        'GET /v1/agents/:agentKey',
        'GET /v1/agents/:agentKey/versions',
        'GET /v1/agents/:agentKey/active',
        'GET /v1/agents/:agentKey/versions/:version/publication-envelope',
        'GET /v1/agents/:agentKey/versions/:version/verification',
        'POST /v1/agents/:agentKey/versions/:version/signatures',
        'GET /v1/public-keys',
        'GET /v1/public-keys/:keyRef',
        'POST /v1/public-keys',
        'POST /v1/public-keys/:keyRef/revoke',
        'GET /v1/transparency-logs',
        'GET /v1/transparency-logs/:logId',
        'GET /v1/transparency-logs/:logId/verification',
        'GET /v1/transparency-logs/:logId/timeline',
        'POST /v1/transparency-logs',
        'POST /v1/transparency-logs/:logId/witnesses',
        'POST /v1/transparency-logs/:logId/checkpoints',
        'POST /v1/transparency-logs/:logId/observations',
        'POST /v1/transparency-logs/:logId/gossip-events',
        'POST /v1/transparency-logs/reconcile',
        'POST /v1/agents',
        'GET /v1/session',
        'GET /v1/skills',
        'GET /v1/skills/:skillKey',
        'POST /v1/skills',
        'GET /v1/skills/:skillKey/versions',
        'GET /v1/skills/:skillKey/versions/:version',
        'GET /v1/skills/:skillKey/versions/:version/publication-envelope',
        'GET /v1/skills/:skillKey/versions/:version/verification',
        'GET /v1/skills/:skillKey/active',
        'POST /v1/skills/:skillKey/drafts',
        'POST /v1/skills/:skillKey/versions/:version/signatures',
        'POST /v1/skills/:skillKey/versions/:version/validate',
        'POST /v1/skills/:skillKey/versions/:version/publish',
        'POST /v1/skills/:skillKey/versions/:version/promote',
        'POST /v1/skills/:skillKey/versions/:version/deprecate',
        'POST /v1/skills/:skillKey/versions/:version/certify',
        'POST /v1/skills/:skillKey/versions/:version/revoke',
        'GET /v1/time-aware/commits',
        'GET /v1/time-aware/commits/:commitId',
        'GET /v1/time-aware/refs',
        'GET /v1/time-aware/refs/:refName',
        'GET /v1/time-aware/tags',
        'GET /v1/time-aware/tags/:tagName',
        'GET /v1/time-aware/workspaces',
        'GET /v1/time-aware/workspaces/:workspaceId',
        'GET /v1/time-aware/manifests',
        'GET /v1/time-aware/retention-roots',
        'GET /v1/time-aware/retention-roots/:rootId/analysis',
        'GET /v1/time-aware/retention-roots/:rootId/gc-plan',
        'GET /v1/time-aware/gc-jobs',
        'GET /v1/graph/subgraph',
        'POST /v1/time-aware/refs/:refName/workspaces/:workspaceId/draft',
      ],
    }),
  );

  app.get('/v1/session', (c) => {
    const principal = c.get('principal');
    if (!principal) {
      return c.json({ error: { code: 'AUTH_UNAUTHENTICATED', message: 'Unauthorized.' } }, 401);
    }

    return c.json(
      {
        auth: {
          mode: deps.env.AUTH_MODE,
          okta_mode: deps.env.OKTA_MODE,
        },
        principal: {
          type: principal.type,
          id: principal.id,
          ...('email' in principal && principal.email ? { email: principal.email } : {}),
          ...('displayName' in principal && principal.displayName ? { display_name: principal.displayName } : {}),
          auth_method: principal.authMethod,
          scopes: principal.scopes,
          groups: principal.groups,
        },
      },
      200,
    );
  });

  return app;
}
