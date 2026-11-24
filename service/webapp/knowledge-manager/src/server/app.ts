import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';

import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { Hono, type Context } from 'hono';

import { APP_CSS } from './assets.js';
import type { Env } from './config/env.js';
import {
  RegistryApiError,
  type AgentSummary,
  type CreateAgentInput,
  type CreateSkillDraftInput,
  type CreateSkillInput,
  type DeFactoTermDetails,
  type GovernanceArtifactRef,
  type OntologyPackageDetails,
  type PendingReviewItem,
  type ProvenanceRecord,
  type RegistryApiClient,
  type ReviewVersionInput,
  type SkillDetails,
  type SkillLifecycleOperationResult,
  type SkillSummary,
  type SkillVersionDetails,
  type SkillVersionOperationInput,
} from './clients/registry-api.js';
import type { SemanticTurkeyClient } from './clients/semantic-turkey.js';
import { logger } from './logging/pino.js';
import { buildAuthorizeUrl, buildPkceState, exchangeCodeForAccessToken, fetchDiscoveryDocument } from './okta-oauth.js';
import type { OperatorSession, OperatorSessionStore } from './session-store.js';
import {
  type PageChromeInput,
  type ReviewEvidenceArtifact,
  type ReviewQueueItem,
  renderAgentDetails,
  renderAgents,
  renderGraphPage,
  renderHome,
  renderFusekiQueries,
  renderLoginPage,
  renderNewAgentForm,
  renderNewSkillForm,
  renderOntologyProjects,
  renderReviews,
  renderSkillDetails,
  renderSkills,
} from './views.js';

const require = createRequire(import.meta.url);
const DEFAULT_GRAPH_ROOT_URN = 'urn:sg:agent:cursor:registry-agent';
const DEFAULT_GRAPH_DEPTH = 3;

export type KnowledgeManagerDeps = {
  env: Env;
  registryApi: RegistryApiClient;
  semanticTurkey: SemanticTurkeyClient;
  sessionStore: OperatorSessionStore;
  fetchFn?: typeof fetch;
};

export function buildApp(deps: KnowledgeManagerDeps) {
  const app = new Hono();

  app.get('/healthz', (c) => c.json({ ok: true }));
  app.get('/readyz', async (c) => {
    const health = await deps.registryApi.health().catch(() => ({ ok: false }));
    return c.json({ ok: health.ok });
  });
  app.get('/assets/cytoscape.min.js', async (c) => {
    try {
      const content = await readFile(resolveCytoscapeAssetPath(), 'utf8');
      c.header('content-type', 'application/javascript; charset=utf-8');
      return c.body(content);
    } catch {
      // No third-party CDN fallback: executable JS must come from the image.
      return c.text('Asset not found.', 404);
    }
  });

  app.get('/assets/app.css', (c) => {
    c.header('content-type', 'text/css; charset=utf-8');
    return c.body(APP_CSS);
  });

  // CSRF protection for all state-changing requests: same-origin check when
  // the Origin header is present, plus a session-bound token (`_csrf` hidden
  // form field). Login itself has no session yet, so it relies on the origin
  // check alone.
  app.use('*', async (c, next) => {
    if (c.req.method !== 'POST') {
      return await next();
    }

    const originError = verifySameOrigin(c);
    if (originError) {
      return c.text(originError, 403);
    }

    if (c.req.path !== '/session/login') {
      const session = await readOperatorSession(c, deps);
      if (session) {
        const body = await c.req.parseBody();
        const token = typeof body['_csrf'] === 'string' ? body['_csrf'] : '';
        if (token === '' || token !== session.csrfToken) {
          return c.text('CSRF validation failed.', 403);
        }
      }
    }

    return await next();
  });

  app.post('/session/login', async (c) => {
    const values = await readFormValues(c);
    const returnTo = normalizeReturnTo(values.return_to);
    if (deps.env.AUTH_MODE === 'api_key') {
      const apiToken = (values.api_token ?? '').trim();
      if (!apiToken) {
        return c.redirect(withSessionMessage(returnTo, { sessionError: 'API bearer token is required.' }), 303);
      }

      try {
        const session = await createOperatorSession(deps, apiToken);
        setOperatorSessionCookie(c, deps.env, session);
        return c.redirect(withSessionMessage(returnTo, { sessionFlash: 'Management session connected.' }), 303);
      } catch (err) {
        const mapped = mapRegistryApiError(err);
        return c.redirect(withSessionMessage(returnTo, { sessionError: mapped.message }), 303);
      }
    }

    if (deps.env.OKTA_MODE === 'mock') {
      try {
        const token = buildMockOktaToken();
        const session = await createOperatorSession(deps, token);
        setOperatorSessionCookie(c, deps.env, session);
        return c.redirect(withSessionMessage(returnTo, { sessionFlash: 'Mock Okta session connected.' }), 303);
      } catch (err) {
        const mapped = mapRegistryApiError(err);
        return c.redirect(withSessionMessage(returnTo, { sessionError: mapped.message }), 303);
      }
    }

    try {
      const discovery = await fetchDiscoveryDocument({
        issuer: requireOktaIssuer(deps.env),
        ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
      });
      const pkce = buildPkceState();
      setOktaLoginCookie(c, deps.env, 'state', pkce.state);
      setOktaLoginCookie(c, deps.env, 'verifier', pkce.verifier);
      setOktaLoginCookie(c, deps.env, 'return_to', returnTo);
      return c.redirect(
        buildAuthorizeUrl({
          authorizationEndpoint: discovery.authorization_endpoint,
          clientId: requireOktaClientId(deps.env),
          redirectUri: deps.env.OKTA_REDIRECT_URI,
          scopes: deps.env.OKTA_SCOPES,
          state: pkce.state,
          codeChallenge: pkce.challenge,
        }),
        303,
      );
    } catch (err) {
      return c.redirect(
        withSessionMessage(returnTo, {
          sessionError: err instanceof Error ? err.message : 'Failed to start Okta login.',
        }),
        303,
      );
    }
  });

  app.get('/session/callback', async (c) => {
    const returnTo = normalizeReturnTo(getOktaLoginCookie(c, deps.env, 'return_to') ?? '/');
    const expectedState = getOktaLoginCookie(c, deps.env, 'state');
    const codeVerifier = getOktaLoginCookie(c, deps.env, 'verifier');
    const code = c.req.query('code');
    const state = c.req.query('state');
    const oktaError = c.req.query('error');
    const oktaErrorDescription = c.req.query('error_description');

    // A real callback carries code+state. Stray or prefetch hits (no params)
    // must NOT clear the pending login cookies, or the real callback fails.
    if (code || state || oktaError) {
      clearOktaLoginCookies(c, deps.env);
    }

    // Okta may redirect back with an ERROR instead of a code (sign-in denied
    // by assignment/sign-on policy, cancelled MFA, ...). Surface and log it;
    // the generic invalid-state message below hid the real reason.
    if (oktaError) {
      logger.warn(
        {
          oktaError,
          oktaErrorDescription: oktaErrorDescription?.slice(0, 300) ?? null,
          hasState: Boolean(state),
          stateMatches: state === expectedState,
        },
        'okta authorization error redirect',
      );
      const detail = oktaErrorDescription ? ` — ${oktaErrorDescription}` : '';
      return c.redirect(
        withSessionMessage(returnTo, { sessionError: `Okta sign-in failed: ${oktaError}${detail}` }),
        303,
      );
    }

    if (!code || !state || !expectedState || !codeVerifier || state !== expectedState) {
      logger.warn(
        {
          hasCode: Boolean(code),
          hasState: Boolean(state),
          hasExpectedState: Boolean(expectedState),
          hasVerifier: Boolean(codeVerifier),
          stateMatches: state === expectedState,
        },
        'okta callback state validation failed',
      );
      const message =
        !code && state && state === expectedState
          ? 'Okta callback did not include an authorization code.'
          : 'Invalid Okta callback state.';
      return c.redirect(withSessionMessage(returnTo, { sessionError: message }), 303);
    }

    try {
      const discovery = await fetchDiscoveryDocument({
        issuer: requireOktaIssuer(deps.env),
        ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
      });
const accessToken = await exchangeCodeForAccessToken({
        tokenEndpoint: discovery.token_endpoint,
        code,
        clientId: requireOktaClientId(deps.env),
        ...(deps.env.OKTA_CLIENT_SECRET ? { clientSecret: deps.env.OKTA_CLIENT_SECRET } : {}),
        redirectUri: deps.env.OKTA_REDIRECT_URI,
codeVerifier,
        ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
      });
      const session = await createOperatorSession(deps, accessToken);
      setOperatorSessionCookie(c, deps.env, session);
      return c.redirect(withSessionMessage(returnTo, { sessionFlash: 'Okta session connected.' }), 303);
    } catch (err) {
      return c.redirect(
        withSessionMessage(returnTo, {
          sessionError: err instanceof Error ? err.message : 'Failed to complete Okta login.',
        }),
        303,
      );
    }
  });

  app.post('/session/logout', async (c) => {
    const values = await readFormValues(c);
    const returnTo = normalizeReturnTo(values.return_to);
    const sessionId = getCookie(c, deps.env.SESSION_COOKIE_NAME);
    if (sessionId) {
      await deps.sessionStore.delete(sessionId);
    }
    deleteCookie(c, deps.env.SESSION_COOKIE_NAME, { path: '/' });
    clearOktaLoginCookies(c, deps.env);
    return c.redirect(withSessionMessage(returnTo, { sessionFlash: 'Management session cleared.' }), 303);
  });

  app.get('/login', async (c) => {
    const session = await readOperatorSession(c, deps);
    const returnTo = normalizeReturnTo(c.req.query('return_to'));
    return c.html(
      renderLoginPage({
        page: buildPageChrome(deps.env, '/login', { return_to: returnTo }, session),
      }),
    );
  });

  app.get('/', async (c) => {
    const counts = await Promise.all([
      deps.registryApi.listAgents().then((b) => b.agents.length).catch(() => undefined),
      deps.registryApi.listSkills().then((b) => b.skills.length).catch(() => undefined),
    ]);
    return c.html(
      renderHome({
        apiOrigin: deps.env.API_ORIGIN,
        ...(deps.env.VOCBENCH_UI_URL ? { vocbenchUiUrl: deps.env.VOCBENCH_UI_URL } : {}),
        ...(deps.env.API_DOCS_URL ? { apiDocsUrl: deps.env.API_DOCS_URL } : {}),
        ...(deps.env.MCP_URL ? { mcpUrl: deps.env.MCP_URL } : {}),
        counts: { agents: counts[0], skills: counts[1] },
        page: buildPageChrome(deps.env, c.req.path, c.req.query(), await readOperatorSession(c, deps)),
      }),
    );
  });

  app.get('/reviews', async (c) => {
    const session = await readOperatorSession(c, deps);
    const flash = c.req.query('flash');
    try {
      const items = await loadReviewQueue(deps.registryApi);
      return c.html(
        renderReviews({
          items,
          ...(flash ? { flash } : {}),
          page: buildPageChrome(deps.env, c.req.path, c.req.query(), session),
        }),
      );
    } catch (err) {
      const mapped = mapRegistryApiError(err);
      return c.html(
        renderReviews({
          items: [],
          error: mapped.message,
          page: buildPageChrome(deps.env, c.req.path, c.req.query(), session),
        }),
        mapped.status,
      );
    }
  });

  app.post('/reviews/:entityType/:key/versions/:version', async (c) => {
    const entityType = c.req.param('entityType');
    const logicalKey = c.req.param('key') ?? '';
    const rawVersion = c.req.param('version');
    const version = rawVersion ? parseVersion(rawVersion) : null;
    const values = await readFormValues(c);
    const session = await readOperatorSession(c, deps);

    const renderQueue = async (input: {
      status?: 200 | 400 | 401 | 403 | 404 | 409 | 500;
      flash?: string;
      error?: string;
      sessionError?: string;
    }) => {
      const items = await loadReviewQueue(deps.registryApi).catch(() => [] as ReviewQueueItem[]);
      return c.html(
        renderReviews({
          items,
          ...(input.flash ? { flash: input.flash } : {}),
          ...(input.error ? { error: input.error } : {}),
          page: buildPageChrome(
            deps.env,
            '/reviews',
            c.req.query(),
            await readOperatorSession(c, deps),
            input.sessionError ? { sessionError: input.sessionError } : undefined,
          ),
        }),
        input.status ?? 200,
      );
    };

    if (entityType !== 'skill' && entityType !== 'agent') {
      return await renderQueue({ status: 400, error: `Unknown review target: ${entityType}.` });
    }
    if (!version) {
      return await renderQueue({ status: 400, error: 'Invalid version for review.' });
    }
    if (!session) {
      return await renderQueue({
        status: 401,
        error: 'Sign in with an API bearer token first.',
        sessionError: 'Sign in with an API bearer token first.',
      });
    }
    if (!isAdminSession(session, deps.env)) {
      return await renderQueue({
        status: 403,
        error: 'Admin access is required to review versions.',
        sessionError: 'Admin access is required to review versions.',
      });
    }
    const decision =
      values.decision === 'approve' ? 'approve' : values.decision === 'reject' ? 'reject' : null;
    const author = (values.author ?? '').trim();
    if (!decision) {
      return await renderQueue({ status: 400, error: 'Choose approve or reject.' });
    }
    if (!author) {
      return await renderQueue({ status: 400, error: 'A reviewer name is required.' });
    }

    const payload: ReviewVersionInput = {
      decision,
      author,
      ...(values.review_role && values.review_role.trim() ? { review_role: values.review_role.trim() } : {}),
      ...(values.note && values.note.trim() ? { note: values.note.trim() } : {}),
    };

    try {
      if (entityType === 'skill') {
        await deps.registryApi.reviewSkillVersion(logicalKey, version, payload, session.apiToken);
      } else {
        await deps.registryApi.reviewAgentVersion(logicalKey, version, payload, session.apiToken);
      }
      return await renderQueue({
        flash: `Review recorded — ${decision} for ${logicalKey} version ${version}.`,
      });
    } catch (err) {
      const mapped = mapRegistryApiError(err);
      return await renderQueue({ status: mapped.status, error: mapped.message });
    }
  });

  app.get('/graph', async (c) => {
    const requested = (c.req.query('root_urn') ?? '').trim();
    const depth = parseGraphDepth(c.req.query('depth'));
    const session = await readOperatorSession(c, deps);

    // No explicit root: pick one that exists (first agent, else first skill)
    // instead of a hardcoded URN that only ever existed in demo data.
    let rootUrn = requested;
    if (!rootUrn) {
      rootUrn = await resolveDefaultGraphRoot(deps.registryApi);
    }

    try {
      const graph = await deps.registryApi.getGraphSubgraph(rootUrn, depth);
      return c.html(
        renderGraphPage({
          graph,
          defaults: { rootUrn, depth },
          page: buildPageChrome(deps.env, c.req.path, c.req.query(), session),
        }),
      );
    } catch (err) {
      const mapped = mapRegistryApiError(err);
      // A missing root is normal for an empty registry: show an empty graph page
      // (200) instead of a 404 for a nav-reachable page. Root-not-found gets a
      // pick-list of existing roots so the page is never a dead end.
      const status = mapped.status === 404 ? 200 : mapped.status;
      const rootSuggestions =
        err instanceof RegistryApiError && err.code === 'GRAPH_ROOT_NOT_FOUND'
          ? await listGraphRootSuggestions(deps.registryApi)
          : [];
      return c.html(
        renderGraphPage({
          graph: {
            root_urn: rootUrn,
            depth,
            nodes: [],
            edges: [],
          },
          defaults: { rootUrn, depth },
          error: mapped.message,
          ...(rootSuggestions.length > 0 ? { rootSuggestions } : {}),
          page: buildPageChrome(deps.env, c.req.path, c.req.query(), session),
        }),
        status,
      );
    }
  });

  app.get('/agents', async (c) => {
    const page = parsePageParam(c.req.query('page'));
    const offset = (page - 1) * PAGE_SIZE;
    const body = await deps.registryApi.listAgents({ limit: PAGE_SIZE, offset });
    const statusByKey = await agentStatusMap(deps.registryApi, body.agents);
    return c.html(
      renderAgents({
        ...body,
        statusByKey,
        paging: { page, pageSize: PAGE_SIZE, hasNext: body.agents.length === PAGE_SIZE, basePath: '/agents' },
        page: buildPageChrome(deps.env, c.req.path, c.req.query(), await readOperatorSession(c, deps)),
      }),
    );
  });

  app.get('/agents/new', async (c) =>
    c.html(
      renderNewAgentForm({
        page: buildPageChrome(deps.env, c.req.path, c.req.query(), await readOperatorSession(c, deps)),
      }),
    ),
  );

  app.post('/agents/new', async (c) => {
    const values = await readFormValues(c);
const session = await readOperatorSession(c, deps);
    const apiToken = session?.apiToken;
    if (!apiToken) {
      return c.html(
        renderNewAgentForm({
          error: 'Sign in with an API bearer token first.',
          values,
          page: buildPageChrome(deps.env, c.req.path, c.req.query(), session, {
            sessionError: 'Sign in with an API bearer token first.',
          }),
        }),
        401,
      );
    }
    if (!isAdminSession(session, deps.env)) {
      return c.html(
        renderNewAgentForm({
          error: 'Admin access is required to create agents.',
          values,
          page: buildPageChrome(deps.env, c.req.path, c.req.query(), session, {
            sessionError: 'Admin access is required to create agents.',
          }),
        }),
        403,
      );
    }

    try {
      const created = await deps.registryApi.createAgent(buildCreateAgentInput(values), apiToken);
      const agentKey = String(created.agent.properties.agent_key ?? values.agent_key);
      return c.redirect(`/agents/${encodeURIComponent(agentKey)}?flash=${encodeURIComponent('Agent created.')}`, 303);
    } catch (err) {
      const mapped = mapRegistryApiError(err);
      return c.html(
        renderNewAgentForm({
          error: mapped.message,
          values,
          page: buildPageChrome(deps.env, c.req.path, c.req.query(), session),
        }),
        mapped.status,
      );
    }
  });

  app.get('/agents/:agentKey', async (c) => {
    try {
      const body = await deps.registryApi.getAgent(c.req.param('agentKey'));
      const flash = c.req.query('flash');

      // Evidence + history are best-effort enrichment; the page must render
      // even when a downstream read fails.
      let activeEvidence: ReviewEvidenceArtifact[] = [];
      let evidenceErrors: string[] = [];
      let provenance: ProvenanceRecord | undefined;
      const activeUrn = body.active_version?.agent_version.urn;
      if (activeUrn) {
        try {
          const { versions } = await deps.registryApi.listAgentVersions(c.req.param('agentKey'));
          const activeVersion = versions.find((candidate) => candidate.agent_version.urn === activeUrn);
          const loaded = await loadValidationEvidence(deps.registryApi, activeVersion?.governance_artifacts);
          activeEvidence = loaded.evidence;
          evidenceErrors = loaded.errors;
          const versionNumber = versionOfProperties(activeVersion?.agent_version.properties ?? {});
          if (versionNumber !== null) {
            provenance = await deps.registryApi
              .getAgentProvenance(c.req.param('agentKey'), versionNumber)
              .catch(() => undefined);
          }
        } catch (err) {
          evidenceErrors = [
            `Version evidence unavailable: ${err instanceof Error ? err.message : 'unknown error'}`,
          ];
        }
      }

      return c.html(
        renderAgentDetails({
          details: body,
          ...(flash ? { flash } : {}),
          activeEvidence,
          evidenceErrors,
          ...(provenance ? { provenance } : {}),
          page: buildPageChrome(deps.env, c.req.path, c.req.query(), await readOperatorSession(c, deps)),
        }),
      );
    } catch (err) {
      const mapped = mapRegistryApiError(err);
      return c.html(renderSimpleErrorPage('Agent not available', mapped.message), mapped.status);
    }
  });

  app.get('/skills', async (c) => {
    const page = parsePageParam(c.req.query('page'));
    const offset = (page - 1) * PAGE_SIZE;
    const body = await deps.registryApi.listSkills({ limit: PAGE_SIZE, offset });
    const statusByKey = await skillStatusMap(deps.registryApi, body.skills);
    return c.html(
      renderSkills({
        ...body,
        statusByKey,
        paging: { page, pageSize: PAGE_SIZE, hasNext: body.skills.length === PAGE_SIZE, basePath: '/skills' },
        page: buildPageChrome(deps.env, c.req.path, c.req.query(), await readOperatorSession(c, deps)),
      }),
    );
  });

  app.get('/skills/new', async (c) =>
    c.html(
      renderNewSkillForm({
        page: buildPageChrome(deps.env, c.req.path, c.req.query(), await readOperatorSession(c, deps)),
      }),
    ),
  );

  app.post('/skills/new', async (c) => {
    const values = await readFormValues(c);
    const session = await readOperatorSession(c, deps);
    const apiToken = session?.apiToken;
    if (!apiToken) {
      return c.html(
        renderNewSkillForm({
          error: 'Sign in with an API bearer token first.',
          values,
          page: buildPageChrome(deps.env, c.req.path, c.req.query(), session, {
            sessionError: 'Sign in with an API bearer token first.',
          }),
        }),
        401,
      );
    }
    if (!isAdminSession(session, deps.env)) {
      return c.html(
        renderNewSkillForm({
          error: 'Admin access is required to create skills.',
          values,
          page: buildPageChrome(deps.env, c.req.path, c.req.query(), session, {
            sessionError: 'Admin access is required to create skills.',
          }),
        }),
        403,
      );
    }

    try {
      const created = await deps.registryApi.createSkill(buildCreateSkillInput(values), apiToken);
      const skillKey = String(created.skill.properties.skill_key ?? values.skill_key);
      return c.redirect(`/skills/${encodeURIComponent(skillKey)}?flash=${encodeURIComponent('Skill created.')}`, 303);
    } catch (err) {
      const mapped = mapRegistryApiError(err);
      return c.html(
        renderNewSkillForm({
          error: mapped.message,
          values,
          page: buildPageChrome(deps.env, c.req.path, c.req.query(), session),
        }),
        mapped.status,
      );
    }
  });

  app.get('/skills/:skillKey', async (c) => {
    const skillKey = c.req.param('skillKey');
    try {
      const { details, versions, activeVersion } = await loadSkillPageData(deps.registryApi, skillKey);
      const flash = c.req.query('flash');
      const usedByAgents = await agentsUsingSkill(deps.registryApi, details.skill.urn, skillKey);

      // Evidence + history are best-effort enrichment; the page must render
      // even when a downstream read fails.
      const loaded = await loadValidationEvidence(deps.registryApi, activeVersion?.governance_artifacts);
      let provenance: ProvenanceRecord | undefined;
      const activeVersionNumber =
        versionOfProperties(activeVersion?.skill_version.properties ?? {}) ?? highestVersionOf(versions);
      if (activeVersionNumber !== null) {
        provenance = await deps.registryApi
          .getSkillProvenance(skillKey, activeVersionNumber)
          .catch(() => undefined);
      }

      return c.html(
        renderSkillDetails({
          details,
          versions,
          activeVersion,
          usedByAgents,
          activeEvidence: loaded.evidence,
          evidenceErrors: loaded.errors,
          ...(flash ? { flash } : {}),
          ...(provenance ? { provenance } : {}),
          page: buildPageChrome(deps.env, c.req.path, c.req.query(), await readOperatorSession(c, deps)),
        }),
      );
    } catch (err) {
      const mapped = mapRegistryApiError(err);
      return c.html(renderSimpleErrorPage('Skill not available', mapped.message), mapped.status);
    }
  });

  app.post('/skills/:skillKey/drafts', async (c) => {
    return await handleSkillDraftWrite(c, deps);
  });

  app.post('/skills/:skillKey/versions/:version/validate', async (c) =>
    await handleSkillVersionWrite(c, deps, {
      action: 'validate',
      successMessage: 'Skill version validated.',
      call: async (skillKey, version, input, apiToken) =>
        await deps.registryApi.validateSkillVersion(skillKey, version, input, apiToken),
    }),
  );

  app.post('/skills/:skillKey/versions/:version/publish', async (c) =>
    await handleSkillVersionWrite(c, deps, {
      action: 'publish',
      successMessage: 'Skill version published.',
      call: async (skillKey, version, input, apiToken) =>
        await deps.registryApi.publishSkillVersion(skillKey, version, input, apiToken),
    }),
  );

  app.post('/skills/:skillKey/versions/:version/promote', async (c) =>
    await handleSkillVersionWrite(c, deps, {
      action: 'promote',
      successMessage: 'Skill version promoted.',
      call: async (skillKey, version, input, apiToken) =>
        await deps.registryApi.promoteSkillVersion(skillKey, version, input, apiToken),
    }),
  );

  app.post('/skills/:skillKey/versions/:version/deprecate', async (c) =>
    await handleSkillVersionWrite(c, deps, {
      action: 'deprecate',
      successMessage: 'Skill version deprecated.',
      call: async (skillKey, version, input, apiToken) =>
        await deps.registryApi.deprecateSkillVersion(skillKey, version, input, apiToken),
    }),
  );

  app.post('/skills/:skillKey/versions/:version/certify', async (c) =>
    await handleSkillVersionWrite(c, deps, {
      action: 'certify',
      successMessage: 'Skill version certified.',
      call: async (skillKey, version, input, apiToken) =>
        await deps.registryApi.certifySkillVersion(skillKey, version, input, apiToken),
    }),
  );

  app.get('/ontology-projects', async (c) => {
    let ontologyPackages: OntologyPackageDetails[] = [];
    let deFactoTerms: DeFactoTermDetails[] = [];
    let registryError: string | undefined;
    try {
      const [packages, terms] = await Promise.all([
        deps.registryApi.listOntologyPackages(),
        deps.registryApi.listDeFactoTerms(),
      ]);
      ontologyPackages = packages.ontology_packages;
      deFactoTerms = terms.terms;
    } catch (err) {
      registryError = err instanceof Error ? err.message : 'Failed to load ontology state from the registry.';
    }
    const projectsView = await deps.semanticTurkey.listProjects();
    const session = await readOperatorSession(c, deps);
    return c.html(
      renderOntologyProjects({
        ontologyPackages,
        deFactoTerms,
        projectsView,
        canReview: Boolean(session),
        ...(registryError ? { registryError } : {}),
        ...(deps.env.VOCBENCH_UI_URL ? { vocbenchUiUrl: deps.env.VOCBENCH_UI_URL } : {}),
        page: buildPageChrome(deps.env, c.req.path, c.req.query(), session),
      }),
    );
  });

  app.post('/ontology-projects/terms/:term/review', async (c) => {
    const session = await readOperatorSession(c, deps);
    if (!session) {
      return c.redirect(withSessionMessage('/ontology-projects', { sessionError: 'Sign in to review ontology terms.' }), 303);
    }
    if (!isAdminSession(session, deps.env)) {
      return c.redirect(
        withSessionMessage('/ontology-projects', { sessionError: 'Admin access is required to review ontology terms.' }),
        303,
      );
    }
    const term = c.req.param('term');
    const values = await readFormValues(c);
    const action = values.action === 'promote' || values.action === 'reject' ? values.action : null;
    if (!action) {
      return c.redirect(withSessionMessage('/ontology-projects', { sessionError: 'Invalid review action.' }), 303);
    }
    try {
      await deps.registryApi.reviewDeFactoTerm(
        term,
        { action, author: session.principalEmail ?? session.principalId },
        session.apiToken,
      );
      return c.redirect(
        withSessionMessage('/ontology-projects', {
          sessionFlash: `Term '${term}' ${action === 'promote' ? 'promoted' : 'rejected'}.`,
        }),
        303,
      );
    } catch (err) {
      const mapped = mapRegistryApiError(err);
      return c.redirect(withSessionMessage('/ontology-projects', { sessionError: mapped.message }), 303);
    }
  });

  app.get('/fuseki-queries', async (c) =>
    c.html(
      renderFusekiQueries({
        fusekiUrl: deps.env.FUSEKI_URL,
        datasetName: 'registry',
        page: buildPageChrome(deps.env, c.req.path, c.req.query(), await readOperatorSession(c, deps)),
      }),
    ),
  );

  app.get('/api/registry/agents', async (c) => c.json(await deps.registryApi.listAgents(), 200));
  app.get('/api/registry/skills', async (c) => c.json(await deps.registryApi.listSkills(), 200));
  app.get('/api/knowledge/ontology-projects', async (c) => c.json(await deps.semanticTurkey.listProjects(), 200));

  return app;
}

async function loadSkillPageData(registryApi: RegistryApiClient, skillKey: string): Promise<{
  details: SkillDetails;
  versions: SkillVersionDetails[];
  activeVersion: SkillVersionDetails | null;
}> {
  const [details, versions, activeVersion] = await Promise.all([
    registryApi.getSkill(skillKey),
    registryApi.listSkillVersions(skillKey).then((body) => body.versions),
    registryApi.getActiveSkillVersion(skillKey),
  ]);

  return { details, versions, activeVersion };
}

async function handleSkillDraftWrite(c: Context, deps: KnowledgeManagerDeps) {
  const skillKey = c.req.param('skillKey') ?? '';
  const values = await readFormValues(c);
  const session = await readOperatorSession(c, deps);
  if (!session) {
    return await renderSkillPage(c, deps, skillKey, {
      status: 401,
      error: 'Sign in with an API bearer token first.',
      formValues: values,
      sessionError: 'Sign in with an API bearer token first.',
    });
  }
  if (!isAdminSession(session, deps.env)) {
    return await renderSkillPage(c, deps, skillKey, {
      status: 403,
      error: 'Admin access is required to create skill drafts.',
      formValues: values,
      sessionError: 'Admin access is required to create skill drafts.',
    });
  }

  try {
    const result = await deps.registryApi.createSkillDraft(skillKey, buildCreateSkillDraftInput(values), session.apiToken);
    return await renderSkillPage(c, deps, skillKey, {
      flash: 'Skill draft created.',
      lifecycleResult: result,
      formValues: values,
    });
  } catch (err) {
    const mapped = mapRegistryApiError(err);
    return await renderSkillPage(c, deps, skillKey, {
      status: mapped.status,
      error: mapped.message,
      formValues: values,
    });
  }
}

async function handleSkillVersionWrite(
  c: Context,
  deps: KnowledgeManagerDeps,
  input: {
    action: 'validate' | 'publish' | 'promote' | 'deprecate' | 'certify';
    successMessage: string;
    call: (
      skillKey: string,
      version: number,
      payload: SkillVersionOperationInput,
      apiToken: string,
    ) => Promise<SkillLifecycleOperationResult>;
  },
) {
  const skillKey = c.req.param('skillKey') ?? '';
  const rawVersion = c.req.param('version');
  const version = rawVersion ? parseVersion(rawVersion) : null;
  const values = await readFormValues(c);
  const session = await readOperatorSession(c, deps);

  if (!version) {
    return await renderSkillPage(c, deps, skillKey, {
      status: 400,
      error: `Invalid version for ${input.action}.`,
      formValues: values,
    });
  }

  if (!session) {
    return await renderSkillPage(c, deps, skillKey, {
      status: 401,
      error: 'Sign in with an API bearer token first.',
      formValues: values,
      sessionError: 'Sign in with an API bearer token first.',
    });
  }
  if (!isAdminSession(session, deps.env)) {
    return await renderSkillPage(c, deps, skillKey, {
      status: 403,
      error: 'Admin access is required to run skill lifecycle operations.',
      formValues: values,
      sessionError: 'Admin access is required to run skill lifecycle operations.',
    });
  }

  try {
    const result = await input.call(skillKey, version, buildSkillVersionOperationInput(values), session.apiToken);
    return await renderSkillPage(c, deps, skillKey, {
      flash: input.successMessage,
      lifecycleResult: result,
      formValues: values,
    });
  } catch (err) {
    const mapped = mapRegistryApiError(err);
    return await renderSkillPage(c, deps, skillKey, {
      status: mapped.status,
      error: mapped.message,
      formValues: values,
    });
  }
}

async function renderSkillPage(
  c: Context,
  deps: KnowledgeManagerDeps,
  skillKey: string,
  input: {
    status?: 200 | 400 | 401 | 403 | 404 | 409 | 500;
    flash?: string;
    error?: string;
    lifecycleResult?: SkillLifecycleOperationResult;
    formValues?: Record<string, string>;
    sessionError?: string;
  },
) {
  const { details, versions, activeVersion } = await loadSkillPageData(deps.registryApi, skillKey);
  const session = await readOperatorSession(c, deps);
  return c.html(
    renderSkillDetails({
      details,
      versions,
      activeVersion,
      ...(input.flash ? { flash: input.flash } : {}),
      ...(input.error ? { error: input.error } : {}),
      ...(input.lifecycleResult ? { lifecycleResult: input.lifecycleResult } : {}),
      ...(input.formValues ? { formValues: input.formValues } : {}),
      page: buildPageChrome(
        deps.env,
        c.req.path,
        c.req.query(),
        session,
        input.sessionError ? { sessionError: input.sessionError } : undefined,
      ),
    }),
    input.status ?? 200,
  );
}

async function createOperatorSession(deps: KnowledgeManagerDeps, apiToken: string) {
  const sessionInfo = await deps.registryApi.getSession(apiToken);
  return deps.sessionStore.create({
    apiToken,
    principalType: sessionInfo.principal.type,
    principalId: sessionInfo.principal.id,
    ...(sessionInfo.principal.email ? { principalEmail: sessionInfo.principal.email } : {}),
    ...(sessionInfo.principal.display_name ? { principalDisplayName: sessionInfo.principal.display_name } : {}),
    groups: sessionInfo.principal.groups,
    scopes: sessionInfo.principal.scopes ?? [],
    authMethod: sessionInfo.principal.auth_method,
  });
}

function isAdminSession(session: OperatorSession | null, env: Env): boolean {
  if (!session) {
    return false;
  }
  if (session.principalType === 'api_key') {
    // API-key sessions are admin only when the key actually carries a write
    // capability; the registry API still enforces the precise per-area scope
    // on every write, so this is the UI-side least-privilege gate.
    return sessionHasWriteScope(session.scopes);
  }
  const adminGroups = env.OKTA_ADMIN_GROUPS.split(/\s*,\s*/).filter(Boolean);
  return adminGroups.some((group) => session.groups.includes(group));
}

function sessionHasWriteScope(scopes: string[]): boolean {
  return scopes.some((scope) => scope === 'lifecycle' || scope.endsWith('write'));
}

function setOperatorSessionCookie(c: Context, env: Env, session: OperatorSession) {
  setCookie(c, env.SESSION_COOKIE_NAME, session.id, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: env.NODE_ENV === 'production',
    path: '/',
    maxAge: env.SESSION_TTL_MINUTES * 60,
  });
}

async function readFormValues(c: Context) {
  // parseBody is cached by Hono, so the CSRF middleware and the handlers can
  // both read the same parsed form.
  const body = await c.req.parseBody();
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(body)) {
    values[key] = typeof value === 'string' ? value : '';
  }
  return values;
}

// Same-origin enforcement for state-changing requests. Proxies terminate TLS,
// so the expected origin is reconstructed from X-Forwarded-Proto/Host when
// present. Requests without an Origin header (curl, tests) are not blocked;
// the session-bound CSRF token remains the primary control.
function verifySameOrigin(c: Context): string | null {
  const origin = c.req.header('origin');
  if (!origin) {
    return null;
  }
  const requestUrl = new URL(c.req.url);
  const proto =
    c.req.header('x-forwarded-proto')?.split(',')[0]?.trim() || requestUrl.protocol.replace(':', '');
  const host = c.req.header('x-forwarded-host')?.split(',')[0]?.trim() || c.req.header('host') || requestUrl.host;
  const expected = `${proto}://${host}`;
  return origin === expected ? null : 'Cross-origin form submission rejected.';
}

function buildCreateAgentInput(values: Record<string, string>): CreateAgentInput {
  const skillRefs = splitLines(values.skill_refs).map((entry) =>
    entry.startsWith('urn:') ? { skill_urn: entry } : { skill_key: entry },
  );

  return {
    agent_key: (values.agent_key ?? '').trim(),
    ...optionalField('harness_name', values.harness_name),
    ...optionalField('display_name', values.display_name),
    ...optionalField('description', values.description),
    ...optionalField('source_path', values.source_path),
    ...(((values.artifact_content ?? '').trim())
      ? {
          artifact: {
            content: values.artifact_content ?? '',
            encoding: 'utf8' as const,
            ...optionalField('media_type', values.artifact_media_type),
            ...optionalField('original_path', values.artifact_original_path),
          },
        }
      : {}),
    ...(skillRefs.length > 0 ? { skill_refs: skillRefs } : {}),
  };
}

function buildCreateSkillInput(values: Record<string, string>): CreateSkillInput {
  return {
    skill_key: (values.skill_key ?? '').trim(),
    ...optionalField('display_name', values.display_name),
    ...optionalField('description', values.description),
    ...optionalField('source_path', values.source_path),
    ...(((values.artifact_content ?? '').trim())
      ? {
          artifact: {
            content: values.artifact_content ?? '',
            encoding: 'utf8' as const,
            ...optionalField('media_type', values.artifact_media_type),
            ...optionalField('original_path', values.artifact_original_path),
          },
        }
      : {}),
  };
}

function buildCreateSkillDraftInput(values: Record<string, string>): CreateSkillDraftInput {
  return {
    author: (values.author ?? '').trim(),
    artifact: {
      content: values.artifact_content ?? '',
      encoding: 'utf8' as const,
      ...optionalField('media_type', values.artifact_media_type),
      ...optionalField('original_path', values.artifact_original_path),
    },
    ...optionalField('display_name', values.display_name),
    ...optionalField('description', values.description),
    ...optionalField('source_path', values.source_path),
    ...optionalField('commit_sha', values.commit_sha),
    ...optionalField('git_tag', values.git_tag),
    ...optionalField('artifact_signature', values.artifact_signature),
  };
}

function buildSkillVersionOperationInput(values: Record<string, string>): SkillVersionOperationInput {
  return {
    author: (values.author ?? '').trim(),
    ...optionalField('note', values.note),
  };
}

function optionalField<TName extends string>(name: TName, value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? ({ [name]: trimmed } as Record<TName, string>) : {};
}

function splitLines(raw: string | undefined) {
  return (raw ?? '')
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function mapRegistryApiError(err: unknown) {
  if (err instanceof RegistryApiError) {
    return {
      status: err.status as 400 | 401 | 403 | 404 | 409 | 500,
      message: err.message,
    };
  }

  return {
    status: 500 as const,
    message: 'Internal error.',
  };
}

const PAGE_SIZE = 20;
const STATUS_ENRICH_MAX = 50;

function parsePageParam(raw: string | string[] | undefined): number {
  const first = Array.isArray(raw) ? raw[0] : raw;
  const n = Number(first);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

function lifecycleOf(properties: Record<string, unknown>): string {
  const raw = properties['lifecycle_status'] ?? properties['lifecycle_state'];
  return typeof raw === 'string' && raw.length > 0 ? raw : 'unknown';
}

async function skillStatusMap(api: RegistryApiClient, skills: SkillSummary[]): Promise<Record<string, string>> {
  if (skills.length === 0 || skills.length > STATUS_ENRICH_MAX) return {};
  const out: Record<string, string> = {};
  await Promise.all(
    skills.map(async (skill) => {
      try {
        const active = await api.getActiveSkillVersion(skill.skill_key);
        out[skill.skill_key] = active ? lifecycleOf(active.skill_version.properties) : 'none';
      } catch {
        out[skill.skill_key] = 'unknown';
      }
    }),
  );
  return out;
}

async function agentStatusMap(api: RegistryApiClient, agents: AgentSummary[]): Promise<Record<string, string>> {
  if (agents.length === 0 || agents.length > STATUS_ENRICH_MAX) return {};
  const out: Record<string, string> = {};
  await Promise.all(
    agents.map(async (agent) => {
      try {
        const details = await api.getAgent(agent.agent_key);
        const active = details.active_version;
        out[agent.agent_key] = active ? lifecycleOf(active.agent_version.properties) : 'none';
      } catch {
        out[agent.agent_key] = 'unknown';
      }
    }),
  );
  return out;
}

async function agentsUsingSkill(api: RegistryApiClient, skillUrn: string, skillKey: string): Promise<string[]> {
  try {
    const { agents } = await api.listAgents({ limit: 100 });
    const matches: string[] = [];
    await Promise.all(
      agents.map(async (agent) => {
        try {
          const details = await api.getAgent(agent.agent_key);
          if (details.skills.some((skill) => skill.skill_urn === skillUrn || skill.skill_key === skillKey)) {
            matches.push(agent.agent_key);
          }
        } catch {
          /* ignore */
        }
      }),
    );
    return matches.sort();
  } catch {
    return [];
  }
}

function buildPageChrome(
  env: Env,
  path: string,
  query: { query(key: string): string | undefined } | Record<string, string | undefined>,
  session: OperatorSession | null,
  overrides?: { sessionError?: string; sessionFlash?: string },
): PageChromeInput {
  const getQueryValue =
    typeof (query as { query?: unknown }).query === 'function'
      ? (key: string) => (query as { query(key: string): string | undefined }).query(key)
      : (key: string) => (query as Record<string, string | undefined>)[key];

  const sessionError = overrides?.sessionError ?? getQueryValue('session_error');
  const sessionFlash = overrides?.sessionFlash ?? getQueryValue('session_flash');

  return {
    path,
    session: {
      authenticated: Boolean(session),
      returnTo: path,
      authMode: env.AUTH_MODE,
      oktaMode: env.OKTA_MODE,
      ...(session ? { expiresAt: session.expiresAt } : {}),
      ...(session?.principalDisplayName
        ? { principalLabel: session.principalDisplayName }
        : session?.principalEmail
          ? { principalLabel: session.principalEmail }
          : session
            ? { principalLabel: session.principalId }
            : {}),
      ...(session ? { authMethod: session.authMethod } : {}),
      ...(session ? { csrfToken: session.csrfToken } : {}),
      ...(sessionFlash ? { flash: sessionFlash } : {}),
      ...(sessionError ? { error: sessionError } : {}),
    },
  };
}

async function readOperatorSession(
  c: Context,
  deps: KnowledgeManagerDeps,
): Promise<OperatorSession | null> {
  const sessionId = getCookie(c, deps.env.SESSION_COOKIE_NAME);
  if (!sessionId) {
    return Promise.resolve(null);
  }
  return await deps.sessionStore.get(sessionId);
}

function buildMockOktaToken() {
  return `webapp-okta-${randomUUID()}`;
}

function requireOktaIssuer(env: Env) {
  if (!env.OKTA_ISSUER) {
    throw new Error('OKTA_ISSUER is required for real Okta session acquisition.');
  }
  return env.OKTA_ISSUER;
}

function requireOktaClientId(env: Env) {
  if (!env.OKTA_CLIENT_ID) {
    throw new Error('OKTA_CLIENT_ID is required for real Okta session acquisition.');
  }
  return env.OKTA_CLIENT_ID;
}

function oktaCookieName(env: Env, suffix: 'state' | 'verifier' | 'return_to') {
  return `${env.SESSION_COOKIE_NAME}_okta_${suffix}`;
}

function setOktaLoginCookie(c: Context, env: Env, suffix: 'state' | 'verifier' | 'return_to', value: string) {
  const isProd = env.NODE_ENV === 'production';
  setCookie(c, oktaCookieName(env, suffix), value, {
    httpOnly: true,
    // The Okta callback is a cross-site top-level navigation (and, behind
    // Cloudflare Access, may pass through an extra redirect). SameSite=Lax is
    // not reliably sent in that path, so use None (Secure) in production.
    sameSite: isProd ? 'None' : 'Lax',
    secure: isProd,
    path: '/',
    maxAge: 10 * 60,
  });
}

function getOktaLoginCookie(c: Context, env: Env, suffix: 'state' | 'verifier' | 'return_to') {
  return getCookie(c, oktaCookieName(env, suffix));
}

function clearOktaLoginCookies(c: Context, env: Env) {
  deleteCookie(c, oktaCookieName(env, 'state'), { path: '/' });
  deleteCookie(c, oktaCookieName(env, 'verifier'), { path: '/' });
  deleteCookie(c, oktaCookieName(env, 'return_to'), { path: '/' });
}

function normalizeReturnTo(raw: string | undefined) {
  if (!raw || !raw.startsWith('/')) {
    return '/';
  }
  return raw;
}

function withSessionMessage(returnTo: string, input: { sessionFlash?: string; sessionError?: string }) {
  const url = new URL(returnTo, 'http://knowledge-manager.local');
  if (input.sessionFlash) {
    url.searchParams.set('session_flash', input.sessionFlash);
  }
  if (input.sessionError) {
    url.searchParams.set('session_error', input.sessionError);
  }
  return `${url.pathname}${url.search}`;
}

function parseVersion(raw: string) {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function parseGraphDepth(raw: string | undefined) {
  const value = Number(raw ?? DEFAULT_GRAPH_DEPTH);
  if (!Number.isFinite(value)) return DEFAULT_GRAPH_DEPTH;
  return Math.min(Math.max(Math.trunc(value), 1), 5);
}

// --- review queue ------------------------------------------------------------

type ReviewCandidate = {
  urn: string;
  version: number | null;
  properties: Record<string, unknown>;
  governanceArtifacts?: GovernanceArtifactRef[];
};

async function loadReviewQueue(api: RegistryApiClient): Promise<ReviewQueueItem[]> {
  const { pending } = await api.listPendingReviews();
  const items: ReviewQueueItem[] = [];
  for (const entry of pending) {
    items.push(await buildReviewQueueItem(api, entry));
  }
  return items;
}

async function buildReviewQueueItem(api: RegistryApiClient, entry: PendingReviewItem): Promise<ReviewQueueItem> {
  const evidence: ReviewEvidenceArtifact[] = [];
  const evidenceErrors: string[] = [];
  let version = parseVersionFromUrn(entry.publication_urn);
  let properties: Record<string, unknown> | null = null;
  let previousProperties: Record<string, unknown> | null = null;
  let diffBaseVersion: number | null = null;
  let artifacts: Array<{ role: string; sha256: string }> = [];
  let detailHref: string | undefined;

  try {
    if (entry.entity_type === 'SKILL_VERSION') {
      const { versions } = await api.listSkillVersions(entry.logical_key);
      const candidates: ReviewCandidate[] = versions.map((candidate) => ({
        urn: candidate.skill_version.urn,
        version: versionOfProperties(candidate.skill_version.properties),
        properties: candidate.skill_version.properties,
        ...(candidate.governance_artifacts ? { governanceArtifacts: candidate.governance_artifacts } : {}),
      }));
      const resolved = resolveReviewTarget(candidates, entry.publication_urn);
      if (resolved) {
        version = resolved.version ?? version;
        properties = resolved.properties;
        artifacts = resolved.artifacts;
        if (resolved.previous) {
          previousProperties = resolved.previous.properties;
          diffBaseVersion = resolved.previous.version;
        }
      }
      detailHref = `/skills/${encodeURIComponent(entry.logical_key)}`;
    } else {
      const { versions } = await api.listAgentVersions(entry.logical_key);
      const candidates: ReviewCandidate[] = versions.map((candidate) => ({
        urn: candidate.agent_version.urn,
        version: versionOfProperties(candidate.agent_version.properties),
        properties: candidate.agent_version.properties,
        ...(candidate.governance_artifacts ? { governanceArtifacts: candidate.governance_artifacts } : {}),
      }));
      const resolved = resolveReviewTarget(candidates, entry.publication_urn);
      if (resolved) {
        version = resolved.version ?? version;
        properties = resolved.properties;
        artifacts = resolved.artifacts;
        if (resolved.previous) {
          previousProperties = resolved.previous.properties;
          diffBaseVersion = resolved.previous.version;
        }
      }
      detailHref = `/agents/${encodeURIComponent(entry.logical_key)}`;
    }
  } catch {
    evidenceErrors.push(`Version details for ${entry.logical_key} are unavailable.`);
  }

  // Validation evidence is best-effort per item: a missing artifact renders as
  // unavailable instead of failing the whole queue.
  const loadedEvidence = await loadValidationEvidence(api, artifacts);
  evidence.push(...loadedEvidence.evidence);
  evidenceErrors.push(...loadedEvidence.errors);

  const diff = properties && previousProperties ? diffProperties(previousProperties, properties) : null;
  return {
    entity_type: entry.entity_type,
    logical_key: entry.logical_key,
    version,
    publication_urn: entry.publication_urn,
    lifecycle_status: entry.lifecycle_status,
    review_status: entry.review_status,
    ...(entry.policy_version ? { policy_version: entry.policy_version } : {}),
    ...(detailHref ? { detail_href: detailHref } : {}),
    diff,
    diff_base_version: diffBaseVersion,
    evidence,
    evidence_errors: evidenceErrors,
    artifacts,
    action_href: `/reviews/${entry.entity_type === 'SKILL_VERSION' ? 'skill' : 'agent'}/${encodeURIComponent(entry.logical_key)}/versions/${version ?? ''}`,
  };
}

function resolveReviewTarget(
  candidates: ReviewCandidate[],
  publicationUrn: string,
): { version: number | null; properties: Record<string, unknown>; artifacts: Array<{ role: string; sha256: string }>; previous: ReviewCandidate | null } | null {
  const target = candidates.find((candidate) => candidate.urn === publicationUrn);
  if (!target) return null;
  return {
    version: target.version,
    properties: target.properties,
    artifacts: governanceArtifactRefs(target.governanceArtifacts),
    previous: findPreviousVersion(candidates, target.version),
  };
}

function findPreviousVersion(candidates: ReviewCandidate[], targetVersion: number | null): ReviewCandidate | null {
  if (targetVersion === null) return null;
  const earlier = candidates.filter(
    (candidate): candidate is ReviewCandidate & { version: number } =>
      candidate.version !== null && candidate.version < targetVersion,
  );
  earlier.sort((left, right) => right.version - left.version);
  return earlier[0] ?? null;
}

function governanceArtifactRefs(refs: GovernanceArtifactRef[] | undefined): Array<{ role: string; sha256: string }> {
  return (refs ?? []).flatMap((ref) => (ref.sha256 ? [{ role: ref.role, sha256: ref.sha256 }] : []));
}

// Validation evidence is best-effort: a missing artifact renders as
// "unavailable" instead of failing the page or the review queue.
async function loadValidationEvidence(
  api: RegistryApiClient,
  refs: Array<{ role: string; sha256?: string }> | undefined,
): Promise<{ evidence: ReviewEvidenceArtifact[]; errors: string[] }> {
  const evidence: ReviewEvidenceArtifact[] = [];
  const errors: string[] = [];
  for (const ref of refs ?? []) {
    if (ref.role !== 'validation_report' || !ref.sha256) continue;
    try {
      const payload = await api.getArtifactJson(ref.sha256);
      if (payload !== null) {
        evidence.push({ sha256: ref.sha256, payload });
      }
    } catch (err) {
      errors.push(
        `Evidence ${ref.sha256.slice(0, 10)}… unavailable: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
    }
  }
  return { evidence, errors };
}

function highestVersionOf(versions: SkillVersionDetails[]): number | null {
  let highest: number | null = null;
  for (const version of versions) {
    const value = versionOfProperties(version.skill_version.properties);
    if (value !== null && (highest === null || value > highest)) {
      highest = value;
    }
  }
  return highest;
}

function versionOfProperties(properties: Record<string, unknown>): number | null {
  const raw = properties.version ?? properties.version_number;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseVersionFromUrn(urn: string): number | null {
  const match = urn.match(/@v(\d+)$/) ?? urn.match(/:(\d+)$/);
  if (!match?.[1]) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function diffProperties(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): ReviewQueueItem['diff'] {
  const changed: Array<{ key: string; from: string; to: string }> = [];
  const added: string[] = [];
  const removed: string[] = [];
  const keys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).sort();
  for (const key of keys) {
    const hasBefore = key in before;
    const hasAfter = key in after;
    if (hasBefore && !hasAfter) {
      removed.push(key);
      continue;
    }
    if (!hasBefore && hasAfter) {
      added.push(key);
      continue;
    }
    const from = stringifyReviewValue(before[key]);
    const to = stringifyReviewValue(after[key]);
    if (from !== to) {
      changed.push({ key, from, to });
    }
  }
  return { changed, added, removed };
}

function stringifyReviewValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  const serialized = JSON.stringify(value);
  return serialized ?? String(value);
}

async function resolveDefaultGraphRoot(registryApi: RegistryApiClient): Promise<string> {
  try {
    const agents = await registryApi.listAgents({ limit: 1 });
    const firstAgent = agents.agents[0]?.agent_urn;
    if (firstAgent) return firstAgent;
  } catch {
    // fall through to skills / constant
  }
  try {
    const skills = await registryApi.listSkills({ limit: 1 });
    const firstSkill = skills.skills[0]?.skill_urn;
    if (firstSkill) return firstSkill;
  } catch {
    // fall through to the constant
  }
  return DEFAULT_GRAPH_ROOT_URN;
}

async function listGraphRootSuggestions(
  registryApi: RegistryApiClient,
): Promise<Array<{ urn: string; label: string }>> {
  const suggestions: Array<{ urn: string; label: string }> = [];
  try {
    const agents = await registryApi.listAgents({ limit: 10 });
    for (const agent of agents.agents) {
      suggestions.push({ urn: agent.agent_urn, label: agent.display_name ?? agent.agent_key ?? agent.agent_urn });
    }
  } catch {
    // suggestions are best-effort
  }
  try {
    const skills = await registryApi.listSkills({ limit: 10 });
    for (const skill of skills.skills) {
      suggestions.push({ urn: skill.skill_urn, label: skill.display_name ?? skill.skill_key ?? skill.skill_urn });
    }
  } catch {
    // suggestions are best-effort
  }
  return suggestions;
}

function resolveCytoscapeAssetPath() {
  return path.join(path.dirname(require.resolve('cytoscape')), 'cytoscape.min.js');
}

function renderSimpleErrorPage(title: string, message: string) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
  </head>
  <body>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
    <p><a href="/">Back</a></p>
  </body>
</html>`;
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
