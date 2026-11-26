import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { buildApp } from '../src/server/app.js';
import type { Env } from '../src/server/config/env.js';
import {
  RegistryApiError,
  type ProvenanceRecord,
  type RegistryApiClient,
  type ReviewOperationResult,
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

  it('sets security headers and pins rendered inline scripts in the CSP', async () => {
    const app = buildApp({
      env,
      registryApi: makeRegistryApiClient(),
      semanticTurkey: {
        listProjects: async () => ({ status: 'not_configured', projects: [] }),
      } satisfies SemanticTurkeyClient,
      sessionStore: new InMemoryOperatorSessionStore({ ttlMinutes: env.SESSION_TTL_MINUTES }),
    });

    const home = await app.request('/');
    expect(home.headers.get('x-frame-options')).toBe('DENY');
    expect(home.headers.get('x-content-type-options')).toBe('nosniff');
    expect(home.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    const csp = home.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).not.toContain("'unsafe-inline'");

    // Every executable inline script in a rendered page must be covered by a
    // sha256 source in that page's CSP header; a new inline script without a
    // hash fails here instead of silently breaking in the browser.
    for (const pathname of ['/', '/graph', '/skills']) {
      const page = await app.request(pathname);
      expect(page.status).toBe(200);
      const header = page.headers.get('content-security-policy') ?? '';
      const html = await page.text();
      const inlineScripts = [
        ...html.matchAll(/<script(?![^>]*\bsrc=)(?![^>]*application\/json)[^>]*>([\s\S]*?)<\/script>/g),
      ];
      expect(inlineScripts.length).toBeGreaterThan(0);
      for (const match of inlineScripts) {
        const digest = createHash('sha256').update(match[1] ?? '', 'utf8').digest('base64');
        expect(header).toContain(`'sha256-${digest}'`);
      }
    }
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

  it('renders freshness chips on list rows, details and version cards', async () => {
    const freshness = {
      freshness: 'fresh' as const,
      last_verified_at: '2026-11-24T00:00:00.000Z',
      verification_basis: 'certified_at' as const,
      age_days: 1,
      certification_expires_at: '2027-05-24T00:00:00.000Z',
      certification_expired: false,
      expires_in_days: 180,
      reasons: [] as string[],
    };
    const version = {
      skill_version: {
        urn: 'urn:sg:skill-version:skill:freshness-probe@v1',
        properties: { version: 1, lifecycle_status: 'published' },
      },
      artifacts: [],
      upstream_versions: [],
      governance_artifacts: [],
      freshness,
    };
    const app = buildApp({
      env,
      registryApi: makeRegistryApiClient({
        listSkills: async () => ({
          skills: [
            {
              skill_urn: 'urn:sg:skill:skill:freshness-probe',
              skill_key: 'skill:freshness-probe',
              display_name: 'Freshness Probe',
              trust: {
                score: 31,
                lifecycle_status: 'certified',
                tier_weight: 3,
                recency_days: 1,
                recency_component: 0.99,
                usage_loads: null,
                usage_component: 0,
              },
              freshness,
            },
          ],
        }),
        getSkill: async () => ({
          skill: { urn: 'urn:sg:skill:skill:freshness-probe', properties: { skill_key: 'skill:freshness-probe' } },
          active_version: version,
          artifacts: [],
        }),
        getActiveSkillVersion: async () => version,
        listSkillVersions: async () => ({ versions: [version] }),
        getUsageSignal: async () => ({
          kind: 'version' as const,
          publication_urn: version.skill_version.urn,
          load_count: 5,
          artifact_fetch_count: 2,
          verify_count: 3,
          verify_failure_count: 0,
          last_loaded_at: '2026-11-25T10:00:00.000Z',
          last_fetched_at: null,
          last_verified_at: null,
          last_verify_failed_at: null,
          updated_at: '2026-11-25T10:00:00.000Z',
        }),
      }),
      semanticTurkey: {
        listProjects: async () => ({ status: 'not_configured', projects: [] }),
      } satisfies SemanticTurkeyClient,
      sessionStore: new InMemoryOperatorSessionStore({ ttlMinutes: env.SESSION_TTL_MINUTES }),
    });

    const list = await app.request('/skills');
    expect(list.status).toBe(200);
    const listText = await list.text();
    expect(listText).toContain('freshness-chip freshness-fresh');
    expect(listText).toContain('verified 1d ago');

    const details = await app.request('/skills/skill%3Afreshness-probe');
    expect(details.status).toBe(200);
    const detailsText = await details.text();
    expect(detailsText).toContain('freshness-chip freshness-fresh');
    expect(detailsText).toContain('certification expires in 180d');
    expect(detailsText).toContain('loaded 5×');
  });

  it('renders the recertification queue with actions for signed-in operators', async () => {
    const queueFixture = {
      items: [
        {
          publication_urn: 'urn:sg:skill-version:skill:stale@v1',
          entity_type: 'SKILL_VERSION' as const,
          logical_key: 'skill:stale',
          version: 1,
          lifecycle_status: 'certified',
          freshness: {
            freshness: 'stale' as const,
            last_verified_at: '2026-01-01T00:00:00.000Z',
            verification_basis: 'certified_at' as const,
            age_days: 328,
            certification_expires_at: null,
            certification_expired: false,
            expires_in_days: null,
            reasons: ['aged'],
          },
          last_revalidated_at: null,
          revalidation_status: null,
          recertification_state: 'due' as const,
          reasons: ['aged'],
          usage_loads: 7,
          last_loaded_at: '2026-11-20T00:00:00.000Z',
        },
      ],
      total: 1,
      due_count: 1,
      approaching_count: 0,
    };
    const app = buildApp({
      env,
      registryApi: makeRegistryApiClient({ getRecertificationQueue: async () => queueFixture }),
      semanticTurkey: {
        listProjects: async () => ({ status: 'not_configured', projects: [] }),
      } satisfies SemanticTurkeyClient,
      sessionStore: new InMemoryOperatorSessionStore({ ttlMinutes: env.SESSION_TTL_MINUTES }),
    });

    const anonymous = await app.request('/recertification');
    expect(anonymous.status).toBe(200);
    const anonymousText = await anonymous.text();
    expect(anonymousText).toContain('skill:stale');
    expect(anonymousText).toContain('Sign in to act.');

    const login = await app.request('/session/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ return_to: '/recertification' }).toString(),
    });
    expect(login.status).toBe(303);
    const cookie = login.headers.get('set-cookie') ?? '';
    const signedIn = await app.request('/recertification', { headers: { cookie } });
    expect(signedIn.status).toBe(200);
    const text = await signedIn.text();
    expect(text).toContain('/recertification/skills/skill%3Astale/versions/1/revalidate');
    expect(text).toContain('/recertification/skills/skill%3Astale/versions/1/recertify');
    expect(text).toContain('Recertify');
    expect(text).toContain('certification_expires_at');
    expect(text).toContain('7 loads');
  });

  it('posts queue actions with the operator session and expiry input', async () => {
    const calls: Array<{ action: string; token: string; payload: Record<string, unknown> }> = [];
    const app = buildApp({
      env,
      registryApi: makeRegistryApiClient({
        recertifySkillVersion: async (_skillKey, _version, input, apiToken) =>
          recordLifecycleCall('recertify', input as unknown as Record<string, unknown>, apiToken, calls),
        getRecertificationQueue: async () => ({ items: [], total: 0, due_count: 0, approaching_count: 0 }),
      }),
      semanticTurkey: {
        listProjects: async () => ({ status: 'not_configured', projects: [] }),
      } satisfies SemanticTurkeyClient,
      sessionStore: new InMemoryOperatorSessionStore({ ttlMinutes: env.SESSION_TTL_MINUTES }),
    });

    const login = await app.request('/session/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ return_to: '/recertification' }).toString(),
    });
    expect(login.status).toBe(303);
    const cookie = login.headers.get('set-cookie') ?? '';
    const csrf = await csrfTokenFor(app, cookie);

    const submit = await app.request('/recertification/skills/skill%3Astale/versions/1/recertify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({
        _csrf: csrf,
        author: 'Jane Doe',
        certification_expires_at: '2027-06-01',
      }).toString(),
    });
    expect(submit.status).toBe(303);
    const location = submit.headers.get('location') ?? '';
    expect(location).toContain('/recertification');
    expect(location).toContain('session_flash');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.action).toBe('recertify');
    expect(calls[0]?.payload).toMatchObject({
      author: 'Jane Doe',
      governance: { certification_expires_at: '2027-06-01' },
    });
  });

  it('offers recertify with an expiry field on certified version cards', async () => {
    const version = {
      skill_version: {
        urn: 'urn:sg:skill-version:skill:certified@v2',
        properties: { version: 2, lifecycle_status: 'certified', certified: true, active: true },
      },
      artifacts: [],
      upstream_versions: [],
      governance_artifacts: [],
    };
    const app = buildApp({
      env,
      registryApi: makeRegistryApiClient({
        getSkill: async () => ({
          skill: { urn: 'urn:sg:skill:skill:certified', properties: { skill_key: 'skill:certified' } },
          active_version: version,
          artifacts: [],
        }),
        getActiveSkillVersion: async () => version,
        listSkillVersions: async () => ({ versions: [version] }),
      }),
      semanticTurkey: {
        listProjects: async () => ({ status: 'not_configured', projects: [] }),
      } satisfies SemanticTurkeyClient,
      sessionStore: new InMemoryOperatorSessionStore({ ttlMinutes: env.SESSION_TTL_MINUTES }),
    });

    const page = await app.request('/skills/skill%3Acertified');
    expect(page.status).toBe(200);
    const text = await page.text();
    expect(text).toContain('Recertify');
    expect(text).toContain('Revalidate');
    expect(text).toContain('certification_expires_at');
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

  it('renders the review queue with validation evidence and records reviews through the session', async () => {
    const calls: Array<{ key: string; version: number; payload: Record<string, unknown>; token: string }> = [];
    const shaclSha = 'a'.repeat(64);

    const app = buildApp({
      env,
      registryApi: makeRegistryApiClient({
        listPendingReviews: async () => ({
          pending: [
            {
              publication_urn: 'urn:sg:skill-version:example:2',
              entity_type: 'SKILL_VERSION',
              logical_key: 'skill:example',
              lifecycle_status: 'validated',
              review_status: 'pending',
              policy_version: 'demo-policy/v1',
            },
          ],
        }),
        listSkillVersions: async () => ({
          versions: [
            {
              skill_version: {
                urn: 'urn:sg:skill-version:example:1',
                properties: { version: 1, description: 'old text', lifecycle_status: 'published' },
              },
              artifacts: [],
              upstream_versions: [],
            },
            {
              skill_version: {
                urn: 'urn:sg:skill-version:example:2',
                properties: { version: 2, description: 'new text', lifecycle_status: 'validated', review_status: 'pending' },
              },
              artifacts: [],
              upstream_versions: [],
              governance_artifacts: [
                { role: 'validation_report', artifact_urn: `urn:sg:artifact:sha256:${shaclSha}`, sha256: shaclSha },
              ],
            },
          ],
        }),
        getArtifactJson: async (sha256) =>
          sha256 === shaclSha
            ? {
                role: 'validation_report',
                payload: {
                  validator: 'shacl-v1',
                  engine: 'shacl-engine@1.1.3+sparql',
                  conforms: true,
                  validated_at: '2026-11-24T00:00:00.000Z',
                  layers: [
                    {
                      layer: 'graph_shape',
                      shape_document: 'registry-graph-shape/builtin',
                      violations: [],
                    },
                  ],
                },
              }
            : null,
        reviewSkillVersion: async (skillKey, version, input, apiToken) => {
          calls.push({ key: skillKey, version, payload: { ...input }, token: apiToken });
          return defaultReviewResult();
        },
      }),
      semanticTurkey: {
        listProjects: async () => ({ status: 'not_configured', projects: [] }),
      } satisfies SemanticTurkeyClient,
      sessionStore: new InMemoryOperatorSessionStore({ ttlMinutes: env.SESSION_TTL_MINUTES }),
    });

    const page = await app.request('/reviews');
    expect(page.status).toBe(200);
    const text = await page.text();
    expect(text).toContain('skill:example');
    expect(text).toContain('Version 2');
    expect(text).toContain('demo-policy/v1');
    expect(text).toContain('Changes vs version 1');
    expect(text).toContain('new text');
    expect(text).toContain('Validation report');
    expect(text).toContain('graph_shape');
    expect(text).toContain('conforms');
    expect(text).toContain('Approve');
    expect(text).toContain('Reject');

    const login = await app.request('/session/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ return_to: '/reviews' }).toString(),
    });
    const cookie = login.headers.get('set-cookie') ?? '';
    const csrf = await csrfTokenFor(app, cookie);

    const submit = await app.request('/reviews/skill/skill%3Aexample/versions/2', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({
        _csrf: csrf,
        decision: 'approve',
        author: 'Jane Doe',
        review_role: 'security-reviewer',
        note: 'looks good',
      }).toString(),
    });

    expect(submit.status).toBe(200);
    await expect(submit.text()).resolves.toContain('Review recorded — approve for skill:example version 2.');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.key).toBe('skill:example');
    expect(calls[0]?.version).toBe(2);
    expect(calls[0]?.payload).toEqual({
      decision: 'approve',
      author: 'Jane Doe',
      review_role: 'security-reviewer',
      note: 'looks good',
    });
    expect(calls[0]?.token).toContain('webapp-okta-');
  });

  it('requires a session and admin rights to record reviews', async () => {
    const reviewCalls: string[] = [];

    const app = buildApp({
      env,
      registryApi: makeRegistryApiClient({
        reviewSkillVersion: async (skillKey, version) => {
          reviewCalls.push(`${skillKey}:${version}`);
          return defaultReviewResult();
        },
      }),
      semanticTurkey: {
        listProjects: async () => ({ status: 'not_configured', projects: [] }),
      } satisfies SemanticTurkeyClient,
      sessionStore: new InMemoryOperatorSessionStore({ ttlMinutes: env.SESSION_TTL_MINUTES }),
    });

    const anon = await app.request('/reviews/skill/skill%3Aexample/versions/2', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ decision: 'approve', author: 'Nobody' }).toString(),
    });
    expect(anon.status).toBe(401);
    await expect(anon.text()).resolves.toContain('Sign in with an API bearer token first.');
    expect(reviewCalls).toHaveLength(0);

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
        reviewSkillVersion: async (skillKey, version) => {
          reviewCalls.push(`${skillKey}:${version}`);
          return defaultReviewResult();
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
      body: new URLSearchParams({ api_token: 'agk_test_readonly', return_to: '/reviews' }).toString(),
    });
    const keyCookie = keyLogin.headers.get('set-cookie') ?? '';
    const keyCsrf = await csrfTokenFor(apiKeyApp, keyCookie);
    const attempt = await apiKeyApp.request('/reviews/skill/skill%3Aexample/versions/2', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: keyCookie },
      body: new URLSearchParams({ _csrf: keyCsrf, decision: 'approve', author: 'Read Only' }).toString(),
    });
    expect(attempt.status).toBe(403);
    await expect(attempt.text()).resolves.toContain('Admin access is required to review versions.');
    expect(reviewCalls).toHaveLength(0);
  });

  it('renders validation evidence and provenance history on the skill detail page', async () => {
    const shaclSha = 'b'.repeat(64);
    const skillUrn = 'urn:sg:skill:skill:example';
    const versionUrn = 'urn:sg:skill-version:skill:example:1';
    const provenanceDigest = 'd'.repeat(64);

    const app = buildApp({
      env,
      registryApi: makeRegistryApiClient({
        getSkill: async () => ({
          skill: { urn: skillUrn, properties: { skill_key: 'skill:example', display_name: 'Example Skill' } },
          artifacts: [],
        }),
        listSkillVersions: async () => ({
          versions: [
            {
              skill_version: {
                urn: versionUrn,
                properties: { version: 1, lifecycle_status: 'published', active: true },
              },
              artifacts: [],
              upstream_versions: [],
              governance_artifacts: [
                { role: 'validation_report', artifact_urn: `urn:sg:artifact:sha256:${shaclSha}`, sha256: shaclSha },
              ],
            },
          ],
        }),
        getActiveSkillVersion: async () => ({
          skill_version: {
            urn: versionUrn,
            properties: { version: 1, lifecycle_status: 'published', active: true },
          },
          artifacts: [],
          upstream_versions: [],
          governance_artifacts: [
            { role: 'validation_report', artifact_urn: `urn:sg:artifact:sha256:${shaclSha}`, sha256: shaclSha },
          ],
        }),
        getArtifactJson: async (sha256) =>
          sha256 === shaclSha
            ? {
                payload: {
                  validator: 'shacl-v1',
                  engine: 'shacl-engine@1.1.3+sparql',
                  conforms: true,
                  validated_at: '2026-11-24T00:00:00.000Z',
                  layers: [
                    { layer: 'graph_shape', violations: [] },
                    {
                      layer: 'dedupe',
                      advisory: true,
                      validator: 'dedupe-v1',
                      threshold: 10,
                      checked_against: 3,
                      candidates: [
                        {
                          logical_key: 'skill:other',
                          score: 14,
                          shared_claims: ['pii-handling'],
                          shared_terms: ['pii'],
                          phrase_match: true,
                        },
                      ],
                      violations: [],
                    },
                  ],
                  rdf: { format: 'jsonld', report: { '@type': 'sh:ValidationReport', 'sh:conforms': true } },
                },
              }
            : null,
        getSkillProvenance: async () => ({
          entity: { urn: skillUrn, entity_type: 'SKILL' },
          derivation_chain: [],
          replay: [
            {
              occurred_at: '2026-11-20T10:00:00.000Z',
              operation: 'create_draft',
              actor: 'pablo',
              version_urn: versionUrn,
              status: 'completed',
            },
            {
              occurred_at: '2026-11-20T10:05:00.000Z',
              operation: 'validate',
              actor: 'pablo',
              version_urn: versionUrn,
              status: 'completed',
            },
            {
              occurred_at: '2026-11-21T09:00:00.000Z',
              operation: 'review',
              actor: 'Dana Reviewer',
              version_urn: versionUrn,
              status: 'completed',
            },
          ],
          evidence: {
            canonical_rdf_sha256: provenanceDigest,
            canonical_rdf_artifact_urn: `urn:sg:artifact:sha256:${provenanceDigest}`,
          },
          provenance_signatures: [],
          all_provenance_signatures_verified: false,
          current_provenance_signed: false,
        }),
      }),
      semanticTurkey: {
        listProjects: async () => ({ status: 'not_configured', projects: [] }),
      } satisfies SemanticTurkeyClient,
      sessionStore: new InMemoryOperatorSessionStore({ ttlMinutes: env.SESSION_TTL_MINUTES }),
    });

    const page = await app.request('/skills/skill%3Aexample');
    expect(page.status).toBe(200);
    const text = await page.text();
    // Validation evidence (SHACL report + standardized JSON-LD report).
    expect(text).toContain('Validation evidence');
    expect(text).toContain('graph_shape');
    expect(text).toContain('sh:ValidationReport');
    // Advisory duplicate candidates render in the dedupe layer.
    expect(text).toContain('possible duplicate: skill:other');
    expect(text).toContain('shares pii-handling');
    expect(text).toContain('near-identical description');
    // Provenance timeline (History tab).
    expect(text).toContain('data-tab="history"');
    expect(text).toContain('create_draft');
    expect(text).toContain('validate');
    expect(text).toContain('Dana Reviewer');
    expect(text).toContain(`canonical ${provenanceDigest.slice(0, 12)}`);
  });

  it('requests trust-ranked agent lists and renders the trust indicator', async () => {
    const listCalls: Array<Record<string, unknown>> = [];
    const app = buildApp({
      env,
      registryApi: makeRegistryApiClient({
        listAgents: async (opts) => {
          listCalls.push({ ...opts });
          return {
            agents: [
              {
                agent_urn: 'urn:sg:agent:cursor:ranked',
                agent_key: 'cursor:ranked',
                harness_name: 'cursor',
                tags: ['platform'],
                trust: {
                  score: 20.5,
                  lifecycle_status: 'published',
                  tier_weight: 2,
                  recency_days: 3,
                  recency_component: 0.9833,
                  usage_loads: null,
                  usage_component: 0,
                },
              },
              { agent_urn: 'urn:sg:agent:cursor:bare', agent_key: 'cursor:bare' },
            ],
          };
        },
      }),
      semanticTurkey: {
        listProjects: async () => ({ status: 'not_configured', projects: [] }),
      } satisfies SemanticTurkeyClient,
      sessionStore: new InMemoryOperatorSessionStore({ ttlMinutes: env.SESSION_TTL_MINUTES }),
    });

    const res = await app.request('/agents');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('Trust');
    expect(text).toContain('20.5');
    expect(text).toContain('tier 2 (published)');
    expect(listCalls[0]?.sort).toBe('trust');

    // Tag links + tag filter passthrough.
    expect(text).toContain('href="/agents?tag=platform"');
    const filtered = await app.request('/agents?tag=platform');
    expect(filtered.status).toBe(200);
    const filteredText = await filtered.text();
    expect(listCalls[1]?.tag).toBe('platform');
    expect(filteredText).toContain('filtered by tag');
    expect(filteredText).toContain('href="/agents?tag=platform"');
  });

  it('renders semantic search results with match components and forwards the mode', async () => {
    const searchCalls: Array<Record<string, unknown>> = [];
    const app = buildApp({
      env,
      registryApi: makeRegistryApiClient({
        searchRegistry: async (input) => {
          searchCalls.push({ ...input });
          return {
            query: input.query,
            mode: input.mode,
            skills: [
              {
                skill_urn: 'urn:sg:skill:skill:pii',
                skill_key: 'skill:pii',
                display_name: 'PII workflows',
                trust: {
                  score: 20.9,
                  lifecycle_status: 'published',
                  tier_weight: 2,
                  recency_days: 1,
                  recency_component: 0.9944,
                  usage_loads: null,
                  usage_component: 0,
                },
                match: {
                  mode: input.mode,
                  score: 9,
                  matched_claims: ['pii-handling'],
                  matched_terms: ['pii', 'handling'],
                  phrase_match: true,
                },
              },
            ],
            agents: [],
          };
        },
      }),
      semanticTurkey: {
        listProjects: async () => ({ status: 'not_configured', projects: [] }),
      } satisfies SemanticTurkeyClient,
      sessionStore: new InMemoryOperatorSessionStore({ ttlMinutes: env.SESSION_TTL_MINUTES }),
    });

    const res = await app.request('/skills?q=PII%20handling&mode=semantic');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(searchCalls[0]).toMatchObject({ query: 'PII handling', type: 'skill', mode: 'semantic' });
    expect(text).toContain('1 semantic match');
    expect(text).toContain('relevance-ordered');
    expect(text).toContain('pii-handling');
    expect(text).toContain('semantic 9');
  });

  it('curates tags through the session and renders them as chips', async () => {
    const setCalls: Array<{ key: string; tags: string[]; token: string }> = [];
    const app = buildApp({
      env,
      registryApi: makeRegistryApiClient({
        getSkill: async () => ({
          skill: {
            urn: 'urn:sg:skill:skill:example',
            properties: {
              skill_key: 'skill:example',
              display_name: 'Example Skill',
              tags: ['security', 'onboarding'],
            },
          },
          artifacts: [],
        }),
        setSkillTags: async (skillKey, tags, apiToken) => {
          setCalls.push({ key: skillKey, tags, token: apiToken });
          return { tags };
        },
      }),
      semanticTurkey: {
        listProjects: async () => ({ status: 'not_configured', projects: [] }),
      } satisfies SemanticTurkeyClient,
      sessionStore: new InMemoryOperatorSessionStore({ ttlMinutes: env.SESSION_TTL_MINUTES }),
    });

    // Detail page renders existing tags (linked to the tag filter) and the form.
    const page = await app.request('/skills/skill%3Aexample');
    expect(page.status).toBe(200);
    const pageText = await page.text();
    expect(pageText).toContain('href="/skills?tag=security"');
    expect(pageText).toContain('Curate tags');
    expect(pageText).toContain('value="security, onboarding"');

    const login = await app.request('/session/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ return_to: '/skills/skill%3Aexample' }).toString(),
    });
    const cookie = login.headers.get('set-cookie') ?? '';
    const csrf = await csrfTokenFor(app, cookie);

    const submit = await app.request('/skills/skill%3Aexample/tags', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ _csrf: csrf, tags: 'Security, onboarding , security, ' }).toString(),
    });
    expect(submit.status).toBe(303);
    expect(decodeURIComponent(submit.headers.get('location') ?? '').replaceAll('+', ' ')).toContain('Tags updated.');
    expect(setCalls[0]).toMatchObject({ key: 'skill:example', tags: ['Security', 'onboarding', 'security'] });
    expect(setCalls[0]?.token).toContain('webapp-okta-');

    // Anonymous submissions redirect to sign-in without touching the registry.
    const anon = await app.request('/skills/skill%3Aexample/tags', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ tags: 'x' }).toString(),
    });
    expect(anon.status).toBe(303);
    expect(decodeURIComponent(anon.headers.get('location') ?? '')).toContain('session_error');
    expect(setCalls).toHaveLength(1);
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
    listPendingReviews: async () => ({ pending: [] }),
    listAgentVersions: async () => ({ versions: [] }),
    reviewSkillVersion: async () => defaultReviewResult(),
    reviewAgentVersion: async () => defaultReviewResult(),
    getArtifactJson: async () => null,
    getSkillProvenance: async () => defaultProvenance(),
    getAgentProvenance: async () => defaultProvenance('AGENT', 'urn:sg:agent:cursor:test'),
    searchRegistry: async (input) => ({
      query: input.query,
      mode: input.mode,
      skills: [],
      agents: [],
    }),
    setSkillTags: async () => ({ tags: [] }),
    setAgentTags: async () => ({ tags: [] }),
    revalidateSkillVersion: async () => {
      throw new Error('revalidateSkillVersion not stubbed');
    },
    recertifySkillVersion: async () => {
      throw new Error('recertifySkillVersion not stubbed');
    },
    revalidateAgentVersion: async () => {
      throw new Error('revalidateAgentVersion not stubbed');
    },
    recertifyAgentVersion: async () => {
      throw new Error('recertifyAgentVersion not stubbed');
    },
    getRecertificationQueue: async () => ({ items: [], total: 0, due_count: 0, approaching_count: 0 }),
    getUsageSignal: async () => null,
    ...overrides,
  };
}

function defaultProvenance(entityType = 'SKILL', urn = 'urn:sg:skill:example'): ProvenanceRecord {
  const digest = 'c'.repeat(64);
  return {
    entity: { urn, entity_type: entityType },
    derivation_chain: [],
    replay: [],
    evidence: {
      canonical_rdf_sha256: digest,
      canonical_rdf_artifact_urn: `urn:sg:artifact:sha256:${digest}`,
    },
    provenance_signatures: [],
    all_provenance_signatures_verified: false,
    current_provenance_signed: false,
  };
}

function defaultReviewResult(): ReviewOperationResult {
  return {
    task: {
      task: { urn: 'urn:sg:task:review', properties: { action: 'review' } },
      targets: [],
    },
    result: {
      skill_version: {
        urn: 'urn:sg:skill-version:example:1',
        properties: { version: 1, lifecycle_status: 'validated' },
      },
      artifacts: [],
      upstream_versions: [],
    },
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
