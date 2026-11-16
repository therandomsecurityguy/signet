import { describe, expect, it } from 'vitest';

import { buildApp } from '../src/server/app.js';
import type { Env } from '../src/server/config/env.js';
import {
  RegistryApiError,
  type RegistryApiClient,
  type SkillLifecycleOperationResult,
} from '../src/server/clients/registry-api.js';
import type { SemanticTurkeyClient } from '../src/server/clients/semantic-turkey.js';
import { InMemoryOperatorSessionStore } from '../src/server/session-store.js';

const env: Env = {
  HOST: '0.0.0.0',
  PORT: 3200,
  LOG_LEVEL: 'silent',
  API_ORIGIN: 'http://api:3100',
  VOCBENCH_UI_URL: 'http://vocbench:1979/vocbench3',
  FUSEKI_URL: 'http://fuseki:3030',
  DATABASE_URL: 'file::memory:',
  AUTH_MODE: 'dual',
  OKTA_MODE: 'mock',
  OKTA_REDIRECT_URI: 'http://localhost:3200/session/callback',
  OKTA_SCOPES: 'openid profile email registry.write',
  OKTA_ADMIN_GROUPS: 'app_signet_admin',
  SESSION_COOKIE_NAME: 'knowledge_manager_session',
  SESSION_TTL_MINUTES: 60,
};

describe('knowledge-manager app', () => {
  async function csrfTokenFor(app: ReturnType<typeof buildApp>, cookie: string): Promise<string> {
    const page = await app.request('/', { headers: { cookie } });
    const html = await page.text();
    const match = html.match(/name="_csrf" value="([^"]+)"/);
    if (!match?.[1]) {
      throw new Error('CSRF token not found on the home page.');
    }
    return match[1];
  }

  it('reports health and readiness', async () => {
    const app = buildApp({
      env,
      registryApi: makeRegistryApiClient(),
      semanticTurkey: {
        listProjects: async () => ({ status: 'not_configured', projects: [] }),
      } satisfies SemanticTurkeyClient,
      sessionStore: new InMemoryOperatorSessionStore({ ttlMinutes: env.SESSION_TTL_MINUTES }),
    });

    const health = await app.request('/healthz');
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({ ok: true });

    const ready = await app.request('/readyz');
    expect(ready.status).toBe(200);
    await expect(ready.json()).resolves.toEqual({ ok: true });
  });

  it('serves the Pico stylesheet and links it from pages', async () => {
    const app = buildApp({
      env,
      registryApi: makeRegistryApiClient(),
      semanticTurkey: {
        listProjects: async () => ({ status: 'not_configured', projects: [] }),
      } satisfies SemanticTurkeyClient,
      sessionStore: new InMemoryOperatorSessionStore({ ttlMinutes: env.SESSION_TTL_MINUTES }),
    });

    const css = await app.request('/assets/app.css');
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toContain('text/css');
    expect((await css.text()).length).toBeGreaterThan(100);

    const home = await app.request('/');
    expect(home.status).toBe(200);
    expect(await home.text()).toContain('/assets/app.css');
  });

  it('surfaces Okta authorization error redirects instead of a generic invalid-state error', async () => {
    const app = buildApp({
      env,
      registryApi: makeRegistryApiClient(),
      semanticTurkey: {
        listProjects: async () => ({ status: 'not_configured', projects: [] }),
      } satisfies SemanticTurkeyClient,
      sessionStore: new InMemoryOperatorSessionStore({ ttlMinutes: env.SESSION_TTL_MINUTES }),
    });

    const state = 'state-123';
    const res = await app.request(
      `/session/callback?error=access_denied&error_description=${encodeURIComponent('User is not assigned to the application.')}&state=${state}`,
      { headers: { cookie: `${env.SESSION_COOKIE_NAME}_okta_state=${state}` } },
    );

    expect(res.status).toBe(303);
    const location = decodeURIComponent(res.headers.get('location') ?? '').replaceAll('+', ' ');
    expect(location).toContain('session_error=Okta sign-in failed: access_denied');
    expect(location).toContain('User is not assigned to the application.');
  });

  it('reports a missing authorization code distinctly when the state matches', async () => {
    const app = buildApp({
      env,
      registryApi: makeRegistryApiClient(),
      semanticTurkey: {
        listProjects: async () => ({ status: 'not_configured', projects: [] }),
      } satisfies SemanticTurkeyClient,
      sessionStore: new InMemoryOperatorSessionStore({ ttlMinutes: env.SESSION_TTL_MINUTES }),
    });

    const state = 'state-456';
    const res = await app.request(`/session/callback?state=${state}`, {
      headers: {
        cookie: [
          `${env.SESSION_COOKIE_NAME}_okta_state=${state}`,
          `${env.SESSION_COOKIE_NAME}_okta_verifier=verifier-1`,
        ].join('; '),
      },
    });

    expect(res.status).toBe(303);
    expect(decodeURIComponent(res.headers.get('location') ?? '').replaceAll('+', ' ')).toContain(
      'did not include an authorization code',
    );
  });

  it('renders agents from the registry API', async () => {
    const app = buildApp({
      env,
      registryApi: makeRegistryApiClient({
        listAgents: async () => ({
          agents: [{ agent_urn: 'urn:sg:agent:cursor:test', agent_key: 'cursor:test', harness_name: 'cursor' }],
        }),
      }),
      semanticTurkey: {
        listProjects: async () => ({ status: 'not_configured', projects: [] }),
      } satisfies SemanticTurkeyClient,
      sessionStore: new InMemoryOperatorSessionStore({ ttlMinutes: env.SESSION_TTL_MINUTES }),
    });

    const res = await app.request('/agents');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('cursor:test');
    expect(text).toContain('/graph?root_urn=urn%3Asg%3Aagent%3Acursor%3Atest&depth=3');
  });

  it('labels skills without an active version instead of showing an unknown state', async () => {
    const app = buildApp({
      env,
      registryApi: makeRegistryApiClient({
        listSkills: async () => ({
          skills: [
            {
              skill_urn: 'urn:sg:skill:skill:rejected-only',
              skill_key: 'skill:rejected-only',
              display_name: 'Rejected Only',
              source_path: 'skills/rejected-only.md',
            },
          ],
        }),
        getActiveSkillVersion: async () => null,
      }),
      semanticTurkey: {
        listProjects: async () => ({ status: 'not_configured', projects: [] }),
      } satisfies SemanticTurkeyClient,
      sessionStore: new InMemoryOperatorSessionStore({ ttlMinutes: env.SESSION_TTL_MINUTES }),
    });

    const res = await app.request('/skills');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('skill:rejected-only');
    expect(text).toContain('no active version');
    expect(text).not.toContain('>unknown<');
  });

  it('adds contextual graph links on agent and skill detail pages', async () => {
    const app = buildApp({
      env,
      registryApi: makeRegistryApiClient({
        getAgent: async () => ({
          agent: {
            urn: 'urn:sg:agent:cursor:test',
            properties: { agent_key: 'cursor:test', harness_name: 'cursor' },
          },
          active_version: {
            agent_version: {
              urn: 'urn:sg:agent-version:cursor:test@v1',
              properties: {
                version: 1,
                publication_status: 'published',
                publisher: 'registry-operator',
              },
            },
            skills: [],
            artifacts: [],
            harnesses: [],
          },
          skills: [],
          artifacts: [],
          harnesses: [],
        }),
      }),
      semanticTurkey: {
        listProjects: async () => ({ status: 'not_configured', projects: [] }),
      } satisfies SemanticTurkeyClient,
      sessionStore: new InMemoryOperatorSessionStore({ ttlMinutes: env.SESSION_TTL_MINUTES }),
    });

    const agent = await app.request('/agents/cursor%3Atest');
    expect(agent.status).toBe(200);
    const agentText = await agent.text();
    expect(agentText).toContain('/graph?root_urn=urn%3Asg%3Aagent%3Acursor%3Atest&depth=3');
    expect(agentText).toContain('Agent Version URN');
    expect(agentText).toContain('registry-operator');

    const skill = await app.request('/skills/skill%3Aexample');
    expect(skill.status).toBe(200);
    await expect(skill.text()).resolves.toContain('/graph?root_urn=urn%3Asg%3Askill%3Aexample&depth=3');
  });

  it('renders lifecycle state and performs lifecycle actions through the mock okta session token', async () => {
    const calls: Array<{ action: string; token: string; payload: Record<string, unknown> }> = [];

    const app = buildApp({
      env,
      registryApi: makeRegistryApiClient({
        getSkill: async () => ({
          skill: {
            urn: 'urn:sg:skill:example',
            properties: { skill_key: 'skill:example', display_name: 'Example Skill' },
          },
          artifacts: [],
        }),
        listSkillVersions: async () => ({
          versions: [
            {
              skill_version: {
                urn: 'urn:sg:skill-version:example:1',
                properties: { version: 1, lifecycle_status: 'draft', active: false, certified: false },
              },
              artifacts: [],
              upstream_versions: [],
            },
            {
              skill_version: {
                urn: 'urn:sg:skill-version:example:2',
                properties: { version: 2, lifecycle_status: 'published', active: true, certified: false },
              },
              artifacts: [],
              upstream_versions: [],
            },
          ],
        }),
        publishSkillVersion: async (_skillKey, _version, input, apiToken) =>
          recordLifecycleCall('publish', input, apiToken, calls),
        validateSkillVersion: async (_skillKey, _version, input, apiToken) =>
          recordLifecycleCall('validate', input, apiToken, calls),
        promoteSkillVersion: async (_skillKey, _version, input, apiToken) =>
          recordLifecycleCall('promote', input, apiToken, calls),
        deprecateSkillVersion: async (_skillKey, _version, input, apiToken) =>
          recordLifecycleCall('deprecate', input, apiToken, calls),
        certifySkillVersion: async (_skillKey, _version, input, apiToken) =>
          recordLifecycleCall('certify', input, apiToken, calls),
      }),
      semanticTurkey: {
        listProjects: async () => ({ status: 'not_configured', projects: [] }),
      } satisfies SemanticTurkeyClient,
      sessionStore: new InMemoryOperatorSessionStore({ ttlMinutes: env.SESSION_TTL_MINUTES }),
    });

    const page = await app.request('/skills/skill%3Aexample');
    expect(page.status).toBe(200);
    const pageText = await page.text();
    expect(pageText).toContain('Version 2');
    expect(pageText).toContain('status:published');
    expect(pageText).toContain('active:yes');
    expect(pageText).toContain('Certify');

    const login = await app.request('/session/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        return_to: '/skills/skill%3Aexample',
      }).toString(),
    });

    expect(login.status).toBe(303);
    const cookie = login.headers.get('set-cookie');
    expect(cookie).toContain(env.SESSION_COOKIE_NAME);
    const csrf = await csrfTokenFor(app, cookie ?? '');

    const submit = await app.request('/skills/skill%3Aexample/versions/2/publish', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookie ?? '',
      },
      body: new URLSearchParams({
        _csrf: csrf,
        author: 'Jane Doe',
        note: 'ready for release',
      }).toString(),
    });

    expect(submit.status).toBe(200);
    const submitText = await submit.text();
    expect(submitText).toContain('Skill version published.');
    expect(submitText).toContain('Last Operation Result');
    expect(submitText).toContain('urn:sg:task:publish');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.action).toBe('publish');
    expect(calls[0]?.token).toContain('webapp-okta-');
    expect(calls[0]?.payload).toEqual({ author: 'Jane Doe', note: 'ready for release' });
  });

  it('re-renders lifecycle errors on the skill page', async () => {
    const app = buildApp({
      env,
      registryApi: makeRegistryApiClient({
        publishSkillVersion: async () => {
          throw new RegistryApiError('Skill cannot be published.', 409, 'SKILL_VERSION_PUBLISH_CONFLICT');
        },
      }),
      semanticTurkey: {
        listProjects: async () => ({ status: 'not_configured', projects: [] }),
      } satisfies SemanticTurkeyClient,
      sessionStore: new InMemoryOperatorSessionStore({ ttlMinutes: env.SESSION_TTL_MINUTES }),
    });

    const login = await app.request('/session/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        return_to: '/skills/skill%3Aexample',
      }).toString(),
    });
    const cookie = login.headers.get('set-cookie');
    const csrf = await csrfTokenFor(app, cookie ?? '');

    const submit = await app.request('/skills/skill%3Aexample/versions/1/publish', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookie ?? '',
      },
      body: new URLSearchParams({
        _csrf: csrf,
        author: 'Jane Doe',
        note: 'publish now',
      }).toString(),
    });

    expect(submit.status).toBe(409);
    await expect(submit.text()).resolves.toContain('Skill cannot be published.');
  });

  it('supports session logout', async () => {
    const app = buildApp({
      env,
      registryApi: makeRegistryApiClient(),
      semanticTurkey: {
        listProjects: async () => ({ status: 'not_configured', projects: [] }),
      } satisfies SemanticTurkeyClient,
      sessionStore: new InMemoryOperatorSessionStore({ ttlMinutes: env.SESSION_TTL_MINUTES }),
    });

    const login = await app.request('/session/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        return_to: '/',
      }).toString(),
    });
    const cookie = login.headers.get('set-cookie');
    const csrf = await csrfTokenFor(app, cookie ?? '');

    const logout = await app.request('/session/logout', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookie ?? '',
      },
      body: new URLSearchParams({
        _csrf: csrf,
        return_to: '/',
      }).toString(),
    });

    expect(logout.status).toBe(303);
    expect(logout.headers.get('location')).toContain('session_flash=');
  });

  it('supports api-key login when api_key mode is configured', async () => {
    const app = buildApp({
      env: {
        ...env,
        AUTH_MODE: 'api_key',
        OKTA_MODE: 'mock',
      },
      registryApi: makeRegistryApiClient(),
      semanticTurkey: {
        listProjects: async () => ({ status: 'not_configured', projects: [] }),
      } satisfies SemanticTurkeyClient,
      sessionStore: new InMemoryOperatorSessionStore({ ttlMinutes: env.SESSION_TTL_MINUTES }),
    });

    const login = await app.request('/session/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        api_token: 'agk_local_token',
        return_to: '/',
      }).toString(),
    });

    expect(login.status).toBe(303);
    expect(login.headers.get('set-cookie')).toContain(env.SESSION_COOKIE_NAME);
  });

  it('renders registry ontology state and reviews de-facto terms with the operator session', async () => {
    const calls: Array<{ term: string; action: string; token: string; author: string }> = [];

    const app = buildApp({
      env,
      registryApi: makeRegistryApiClient({
        listOntologyPackages: async () => ({
          ontology_packages: [
            {
              artifact_urn: 'urn:sg:artifact:sha256:abc',
              sha256: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
              ontology_version: 'registry-shape/v1',
              ontology_kind: 'registry_shape',
              created_by: 'signet-ci',
              created_at: '2026-11-12T00:00:00.000Z',
              description: 'Registry shape ontology',
              ontology: {},
            },
          ],
        }),
        listDeFactoTerms: async () => ({
          terms: [
            {
              urn: 'urn:sg:de-facto-term:otel',
              term: 'otel',
              status: 'candidate',
              first_seen_at: '2026-11-01T00:00:00.000Z',
              last_seen_at: '2026-11-12T00:00:00.000Z',
              seen_count: 3,
              example_publication_urns: [],
            },
          ],
        }),
        reviewDeFactoTerm: async (term, input, apiToken) => {
          calls.push({ term, action: input.action, token: apiToken, author: input.author });
          return {
            urn: `urn:sg:de-facto-term:${term}`,
            term,
            status: input.action === 'promote' ? 'promoted' : 'rejected',
            first_seen_at: '',
            last_seen_at: '',
            seen_count: 3,
            example_publication_urns: [],
          };
        },
      }),
      semanticTurkey: {
        listProjects: async () => ({ status: 'not_configured', projects: [] }),
      } satisfies SemanticTurkeyClient,
      sessionStore: new InMemoryOperatorSessionStore({ ttlMinutes: env.SESSION_TTL_MINUTES }),
    });

    const page = await app.request('/ontology-projects');
    expect(page.status).toBe(200);
    const text = await page.text();
    expect(text).toContain('registry-shape/v1');
    expect(text).toContain('otel');
    expect(text).toContain('vocabulary');

    const anon = await app.request('/ontology-projects/terms/otel/review', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ action: 'promote' }).toString(),
    });
    expect(anon.status).toBe(303);
    expect(anon.headers.get('location')).toContain('session_error');
    expect(calls).toHaveLength(0);

    const login = await app.request('/session/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ return_to: '/ontology-projects' }).toString(),
    });
    expect(login.status).toBe(303);
    const cookie = login.headers.get('set-cookie') ?? '';
    const csrf = await csrfTokenFor(app, cookie);

    const submit = await app.request('/ontology-projects/terms/otel/review', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie,
      },
      body: new URLSearchParams({ _csrf: csrf, action: 'promote' }).toString(),
    });
    expect(submit.status).toBe(303);
    expect(submit.headers.get('location')).toContain('session_flash');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.term).toBe('otel');
    expect(calls[0]?.action).toBe('promote');
    expect(calls[0]?.token).toContain('webapp-okta-');
  });

  it('rejects state-changing requests with a missing or wrong CSRF token', async () => {
    const app = buildApp({
      env,
      registryApi: makeRegistryApiClient(),
      semanticTurkey: {
        listProjects: async () => ({ status: 'not_configured', projects: [] }),
      } satisfies SemanticTurkeyClient,
      sessionStore: new InMemoryOperatorSessionStore({ ttlMinutes: env.SESSION_TTL_MINUTES }),
    });

    const login = await app.request('/session/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ return_to: '/' }).toString(),
    });
    const cookie = login.headers.get('set-cookie') ?? '';

    const missing = await app.request('/agents/new', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ agent_key: 'cursor:csrf-test', harness_name: 'cursor' }).toString(),
    });
    expect(missing.status).toBe(403);

    const csrf = await csrfTokenFor(app, cookie);
    const wrong = await app.request('/agents/new', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({
        _csrf: `wrong-${csrf}`,
        agent_key: 'cursor:csrf-test',
        harness_name: 'cursor',
      }).toString(),
    });
    expect(wrong.status).toBe(403);

    const crossOrigin = await app.request('/agents/new', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, origin: 'https://evil.example' },
      body: new URLSearchParams({
        _csrf: csrf,
        agent_key: 'cursor:csrf-test',
        harness_name: 'cursor',
      }).toString(),
    });
    expect(crossOrigin.status).toBe(403);
  });

  it('requires admin rights (Okta group or write scope) for governance actions', async () => {
    const reviewedTerms: string[] = [];
    const app = buildApp({
      env,
      registryApi: makeRegistryApiClient({
        getSession: async (apiToken) => ({
          auth: { mode: apiToken.startsWith('agk_') ? 'api_key' : 'dual', okta_mode: 'mock' },
          principal: {
            type: apiToken.startsWith('agk_') ? 'api_key' : 'okta_user',
            id: apiToken.startsWith('agk_') ? 'api-key-principal' : 'okta-principal',
            auth_method: apiToken.startsWith('agk_') ? 'api_key' : 'okta_access_token',
            // Read-only key scope and a non-admin Okta group: neither session
            // may promote governance terms.
            scopes: apiToken.startsWith('agk_') ? ['read'] : ['registry.write'],
            groups: apiToken.startsWith('agk_') ? [] : ['mock-group'],
          },
        }),
        reviewDeFactoTerm: async (term, input) => {
          reviewedTerms.push(`${term}:${input.action}`);
          return {
            urn: `urn:sg:de-facto-term:${term}`,
            term,
            status: 'promoted',
            first_seen_at: '',
            last_seen_at: '',
            seen_count: 1,
            example_publication_urns: [],
          };
        },
      }),
      semanticTurkey: {
        listProjects: async () => ({ status: 'not_configured', projects: [] }),
      } satisfies SemanticTurkeyClient,
      sessionStore: new InMemoryOperatorSessionStore({ ttlMinutes: env.SESSION_TTL_MINUTES }),
    });

    const oktaLogin = await app.request('/session/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ return_to: '/ontology-projects' }).toString(),
    });
    const oktaCookie = oktaLogin.headers.get('set-cookie') ?? '';
    const oktaCsrf = await csrfTokenFor(app, oktaCookie);
    const oktaAttempt = await app.request('/ontology-projects/terms/otel/review', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: oktaCookie },
      body: new URLSearchParams({ _csrf: oktaCsrf, action: 'promote' }).toString(),
    });
    expect(oktaAttempt.status).toBe(303);
    expect(oktaAttempt.headers.get('location')).toContain('session_error');
    expect(reviewedTerms).toHaveLength(0);

    const apiKeyApp = buildApp({
      env: { ...env, AUTH_MODE: 'api_key' },
      registryApi: makeRegistryApiClient({
        getSession: async () => ({
          auth: { mode: 'api_key', okta_mode: 'mock' },
          principal: {
            type: 'api_key',
            id: 'api-key-principal',
            auth_method: 'api_key',
            scopes: ['read'],
            groups: [],
          },
        }),
        reviewDeFactoTerm: async (term, input) => {
          reviewedTerms.push(`${term}:${input.action}`);
          return {
            urn: `urn:sg:de-facto-term:${term}`,
            term,
            status: 'promoted',
            first_seen_at: '',
            last_seen_at: '',
            seen_count: 1,
            example_publication_urns: [],
          };
        },
      }),
      semanticTurkey: {
        listProjects: async () => ({ status: 'not_configured', projects: [] }),
      } satisfies SemanticTurkeyClient,
      sessionStore: new InMemoryOperatorSessionStore({ ttlMinutes: env.SESSION_TTL_MINUTES }),
    });

    const keyLogin = await apiKeyApp.request('/session/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ api_token: 'agk_test_readonly', return_to: '/ontology-projects' }).toString(),
    });
    const keyCookie = keyLogin.headers.get('set-cookie') ?? '';
    const keyCsrf = await csrfTokenFor(apiKeyApp, keyCookie);
    const keyAttempt = await apiKeyApp.request('/ontology-projects/terms/otel/review', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: keyCookie },
      body: new URLSearchParams({ _csrf: keyCsrf, action: 'promote' }).toString(),
    });
    expect(keyAttempt.status).toBe(303);
    expect(keyAttempt.headers.get('location')).toContain('session_error');
    expect(reviewedTerms).toHaveLength(0);
  });

  it('exposes ontology project JSON and html views', async () => {
    const app = buildApp({
      env,
      registryApi: makeRegistryApiClient(),
      semanticTurkey: {
        listProjects: async () => ({
          status: 'configured',
          projects: [{ name: 'my_ontology' }],
        }),
      } satisfies SemanticTurkeyClient,
      sessionStore: new InMemoryOperatorSessionStore({ ttlMinutes: env.SESSION_TTL_MINUTES }),
    });

    const json = await app.request('/api/knowledge/ontology-projects');
    expect(json.status).toBe(200);
    await expect(json.json()).resolves.toMatchObject({
      status: 'configured',
      projects: [{ name: 'my_ontology' }],
    });

    const html = await app.request('/ontology-projects');
    expect(html.status).toBe(200);
    await expect(html.text()).resolves.toContain('my_ontology');
  });

  it('exposes a Fuseki query shortcut page', async () => {
    const app = buildApp({
      env,
      registryApi: makeRegistryApiClient(),
      semanticTurkey: {
        listProjects: async () => ({ status: 'not_configured', projects: [] }),
      } satisfies SemanticTurkeyClient,
      sessionStore: new InMemoryOperatorSessionStore({ ttlMinutes: env.SESSION_TTL_MINUTES }),
    });

    const home = await app.request('/');
    expect(home.status).toBe(200);
    await expect(home.text()).resolves.toContain('/fuseki-queries');

    const page = await app.request('/fuseki-queries');
    expect(page.status).toBe(200);
    const text = await page.text();
    expect(text).toContain('Fuseki Query Shortcuts');
    expect(text).toContain('Count Nodes By Entity Type');
    expect(text).toContain('Artifact Linking Edges');
    expect(text).toContain('docs/fuseki-query-pack.md');
  });

  it('renders a graph explorer page', async () => {
    const app = buildApp({
      env,
      registryApi: makeRegistryApiClient({
        getGraphSubgraph: async () => ({
          root_urn: 'urn:sg:agent:cursor:registry-agent',
          depth: 3,
          nodes: [
            {
              id: 'urn:sg:agent:cursor:registry-agent',
              urn: 'urn:sg:agent:cursor:registry-agent',
              entity_type: 'AGENT',
              label: 'Registry Demo Agent',
              properties: {},
            },
            {
              id: 'urn:sg:skill:skill:tame-llama',
              urn: 'urn:sg:skill:skill:tame-llama',
              entity_type: 'SKILL',
              label: 'Tame A Llama',
              properties: {},
            },
          ],
          edges: [
            {
              id: 'urn:sg:agent:cursor:registry-agent|sg:usesSkill|urn:sg:skill:skill:tame-llama',
              from_urn: 'urn:sg:agent:cursor:registry-agent',
              to_urn: 'urn:sg:skill:skill:tame-llama',
              predicate: 'sg:usesSkill',
              label: 'sg:usesSkill',
            },
          ],
        }),
      }),
      semanticTurkey: {
        listProjects: async () => ({ status: 'not_configured', projects: [] }),
      } satisfies SemanticTurkeyClient,
      sessionStore: new InMemoryOperatorSessionStore({ ttlMinutes: env.SESSION_TTL_MINUTES }),
    });

    const home = await app.request('/');
    expect(home.status).toBe(200);
    await expect(home.text()).resolves.toContain('/graph');

    const page = await app.request('/graph');
    expect(page.status).toBe(200);
    const text = await page.text();
    expect(text).toContain('Graph Explorer');
    expect(text).toContain('Registry Demo Agent');
    expect(text).toContain('/assets/cytoscape.min.js');
    expect(text).toContain('Selected Node');
    expect(text).toContain('Open canonical detail page');
    expect(text).toContain('"root_urn":"urn:sg:agent:cursor:registry-agent"');
    expect(text).not.toContain('&quot;root_urn&quot;');
  });

  it('resolves the default graph root dynamically and suggests roots when one is missing', async () => {
    const app = buildApp({
      env,
      registryApi: makeRegistryApiClient({
        getGraphSubgraph: async (rootUm: string, depth: number) => {
          if (rootUm === 'urn:sg:agent:cursor:missing') {
            throw new RegistryApiError('Graph root not found.', 404, 'GRAPH_ROOT_NOT_FOUND');
          }
          return { root_urn: rootUm, depth, nodes: [], edges: [] };
        },
        listAgents: async () => ({
          agents: [
            {
              agent_urn: 'urn:sg:agent:cursor:signet-security-agent',
              agent_key: 'cursor:signet-security-agent',
              display_name: 'Signet Security Agent',
            },
          ],
        }),
        listSkills: async () => ({
          skills: [
            {
              skill_urn: 'urn:sg:skill:skill:argocd-break-glass',
              skill_key: 'skill:argocd-break-glass',
              display_name: 'Argo CD Break-Glass',
            },
          ],
        }),
      }),
      semanticTurkey: {
        listProjects: async () => ({ status: 'not_configured', projects: [] }),
      } satisfies SemanticTurkeyClient,
      sessionStore: new InMemoryOperatorSessionStore({ ttlMinutes: env.SESSION_TTL_MINUTES }),
    });

    // No root parameter: the page resolves the first existing agent instead of
    // a hardcoded demo URN.
    const auto = await app.request('/graph');
    expect(auto.status).toBe(200);
    expect(await auto.text()).toContain('urn:sg:agent:cursor:signet-security-agent');

    // Missing root: honest error plus a pick-list, never a dead end.
    const page = await app.request('/graph?root_urn=urn%3Asg%3Aagent%3Acursor%3Amissing');
    expect(page.status).toBe(200);
    const text = await page.text();
    expect(text).toContain('Graph root not found.');
    expect(text).toContain('Pick an existing root:');
    expect(text).toContain('Signet Security Agent');
    expect(text).toContain('Argo CD Break-Glass');
  });
});

function makeRegistryApiClient(overrides?: Partial<RegistryApiClient>): RegistryApiClient {
  return {
    health: async () => ({ ok: true }),
    getSession: async (apiToken) => ({
      auth: {
        mode: apiToken.startsWith('agk_') ? 'api_key' : 'dual',
        okta_mode: 'mock',
      },
      principal: {
        type: apiToken.startsWith('agk_') ? 'api_key' : 'okta_user',
        id: apiToken.startsWith('agk_') ? 'api-key-principal' : 'okta-principal',
        auth_method: apiToken.startsWith('agk_') ? 'api_key' : 'okta_access_token',
        scopes: ['registry.write'],
        groups: ['mock-group', 'app_signet_admin'],
        ...(apiToken.startsWith('agk_') ? {} : { display_name: 'Mock Okta User' }),
      },
    }),
    getGraphSubgraph: async () => ({
      root_urn: 'urn:sg:agent:cursor:registry-agent',
      depth: 3,
      nodes: [],
      edges: [],
    }),
    listAgents: async () => ({ agents: [] }),
    getAgent: async () => ({
      agent: {
        urn: 'urn:sg:agent:cursor:test',
        properties: { agent_key: 'cursor:test', harness_name: 'cursor' },
      },
      skills: [],
      artifacts: [],
      harnesses: [],
    }),
    createAgent: async () => ({
      agent: {
        urn: 'urn:sg:agent:cursor:test',
        properties: { agent_key: 'cursor:test', harness_name: 'cursor' },
      },
      skills: [],
      artifacts: [],
      harnesses: [],
    }),
    listSkills: async () => ({ skills: [] }),
    getSkill: async () => ({
      skill: {
        urn: 'urn:sg:skill:example',
        properties: { skill_key: 'skill:example' },
      },
      artifacts: [],
    }),
    createSkill: async () => ({
      skill: {
        urn: 'urn:sg:skill:example',
        properties: { skill_key: 'skill:example' },
      },
      artifacts: [],
    }),
    listSkillVersions: async () => ({ versions: [] }),
    getActiveSkillVersion: async () => null,
    createSkillDraft: async () => ({
      task: {
        task: { urn: 'urn:sg:task:1', properties: {} },
        targets: [],
      },
      result: {
        skill_version: {
          urn: 'urn:sg:skill-version:example:1',
          properties: { version: 1, lifecycle_status: 'draft', active: false, certified: false },
        },
        artifacts: [],
        upstream_versions: [],
      },
    }),
    validateSkillVersion: async () => defaultLifecycleResult('validate'),
    publishSkillVersion: async () => defaultLifecycleResult('publish'),
    promoteSkillVersion: async () => defaultLifecycleResult('promote'),
    deprecateSkillVersion: async () => defaultLifecycleResult('deprecate'),
    certifySkillVersion: async () => defaultLifecycleResult('certify'),
    listOntologyPackages: async () => ({ ontology_packages: [] }),
    listDeFactoTerms: async () => ({ terms: [] }),
    reviewDeFactoTerm: async (term, input) => ({
      urn: `urn:sg:de-facto-term:${term}`,
      term,
      status: input.action === 'promote' ? 'promoted' : 'rejected',
      first_seen_at: '',
      last_seen_at: '',
      seen_count: 0,
      example_publication_urns: [],
    }),
    ...overrides,
  };
}

function defaultLifecycleResult(action: string): SkillLifecycleOperationResult {
  return {
    task: {
      task: { urn: `urn:sg:task:${action}`, properties: { action } },
      targets: [],
    },
    result: {
      skill_version: {
        urn: 'urn:sg:skill-version:example:1',
        properties: { version: 1, lifecycle_status: 'published', active: true, certified: false },
      },
      artifacts: [],
      upstream_versions: [],
    },
  };
}

function recordLifecycleCall(
  action: string,
  input: Record<string, unknown>,
  apiToken: string,
  calls: Array<{ action: string; token: string; payload: Record<string, unknown> }>,
): SkillLifecycleOperationResult {
  calls.push({ action, token: apiToken, payload: input });
  return defaultLifecycleResult(action);
}
