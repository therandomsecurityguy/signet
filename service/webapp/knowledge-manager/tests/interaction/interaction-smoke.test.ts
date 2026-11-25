// Headless-browser interaction smoke for the knowledge-manager UI.
//
// Boots the real HTTP app in-process (registry API faked, no external
// services), drives it with Chromium, and asserts the behaviors that only
// exist in the browser: tab switching, copy-to-clipboard, client-side table
// filtering, graph canvas rendering, and the login card.
//
// Gated like the other e2e suites. Run with:
//   npx playwright install chromium   # once per machine
//   npm run test:interactions
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serve, type ServerType } from '@hono/node-server';
import { chromium, type Browser, type Page } from 'playwright';

import { buildApp } from '../../src/server/app.js';
import type { Env } from '../../src/server/config/env.js';
import type {
  AgentDetails,
  RegistryApiClient,
  SkillDetails,
  SkillLifecycleOperationResult,
  SkillVersionDetails,
} from '../../src/server/clients/registry-api.js';
import type { SemanticTurkeyClient } from '../../src/server/clients/semantic-turkey.js';
import { InMemoryOperatorSessionStore } from '../../src/server/session-store.js';

const enabled = process.env['ENABLE_INTERACTION_E2E'] === '1';
const maybeDescribe = enabled ? describe : describe.skip;

const env: Env = {
  HOST: '127.0.0.1',
  PORT: 3200,
  LOG_LEVEL: 'silent',
  API_ORIGIN: 'http://api:3100',
  FUSEKI_URL: 'http://fuseki:3030',
  DATABASE_URL: 'file::memory:',
  AUTH_MODE: 'api_key',
  OKTA_MODE: 'mock',
  OKTA_REDIRECT_URI: 'http://localhost:3200/session/callback',
  OKTA_SCOPES: 'openid profile email',
  OKTA_ADMIN_GROUPS: 'app_signet_admin',
  SESSION_COOKIE_NAME: 'knowledge_manager_session',
  SESSION_TTL_MINUTES: 60,
};

// --- fixtures ---------------------------------------------------------------

const REGISTRY_AGENT_URN = 'urn:sg:agent:cursor:registry-agent';
const SECURITY_AGENT_URN = 'urn:sg:agent:cursor:signet-security-agent';
const TAME_LLAMA_URN = 'urn:sg:skill:skill:tame-llama';

const tameLlamaArtifact = {
  artifact_urn: 'urn:sg:artifact:sha256:e93e2e50aec0b1773c9f974c2d0dc4e8cb6c8d20ff3870b7c09729a18a74c6de',
  sha256: 'e93e2e50aec0b1773c9f974c2d0dc4e8cb6c8d20ff3870b7c09729a18a74c6de',
};

const tameLlamaVersion: SkillVersionDetails = {
  skill_version: {
    urn: 'urn:sg:skill-version:skill:tame-llama@v1',
    properties: {
      skill_key: 'skill:tame-llama',
      version: 1,
      lifecycle_status: 'published',
      active: true,
      certified: false,
      publisher: 'registry-operator',
      published_at: '2026-11-15T02:44:57.346Z',
    },
  },
  artifacts: [tameLlamaArtifact],
  upstream_versions: [],
  governance_artifacts: [
    {
      role: 'validation_report',
      artifact_urn: `urn:sg:artifact:sha256:${'e'.repeat(64)}`,
      sha256: 'e'.repeat(64),
    },
  ],
};

const tameLlamaDetails: SkillDetails = {
  skill: {
    urn: TAME_LLAMA_URN,
    properties: {
      skill_key: 'skill:tame-llama',
      display_name: 'Tame A Llama',
      description: 'A playful skill used to prove MCP discovery and load.',
      source_path: 'client/registry-cli/examples/demo/skills/tame-llama.md',
    },
  },
  artifacts: [tameLlamaArtifact],
};

const registryAgentDetails: AgentDetails = {
  agent: {
    urn: REGISTRY_AGENT_URN,
    properties: {
      agent_key: 'cursor:registry-agent',
      harness_name: 'cursor',
      display_name: 'Registry Demo Agent',
    },
  },
  active_version: {
    agent_version: {
      urn: 'urn:sg:agent-version:cursor:registry-agent@v1',
      properties: { version: 1, lifecycle_status: 'published', publisher: 'registry-operator' },
    },
    skills: [{ skill_urn: TAME_LLAMA_URN, skill_key: 'skill:tame-llama' }],
    artifacts: [],
    harnesses: [],
  },
  skills: [{ skill_urn: TAME_LLAMA_URN, skill_key: 'skill:tame-llama' }],
  artifacts: [],
  harnesses: [{ harness_urn: 'urn:sg:harness:cursor', harness_name: 'cursor' }],
};

const securityAgentDetails: AgentDetails = {
  agent: {
    urn: SECURITY_AGENT_URN,
    properties: {
      agent_key: 'cursor:signet-security-agent',
      harness_name: 'cursor',
      display_name: 'Signet Security Agent',
    },
  },
  active_version: {
    agent_version: {
      urn: 'urn:sg:agent-version:cursor:signet-security-agent@v1',
      properties: { version: 1, lifecycle_status: 'published', publisher: 'registry-operator' },
    },
    skills: [],
    artifacts: [],
    harnesses: [],
  },
  skills: [],
  artifacts: [],
  harnesses: [],
};

function makeRegistryApiClient(): RegistryApiClient {
  return {
    health: async () => ({ ok: true }),
    getSession: async (apiToken) => ({
      auth: { mode: apiToken.startsWith('agk_') ? 'api_key' : 'dual', okta_mode: 'mock' },
      principal: {
        type: 'api_key',
        id: 'api-key-principal',
        auth_method: 'api_key',
        scopes: ['registry.write'],
        groups: [],
      },
    }),
    getGraphSubgraph: async (rootUrn, depth) => ({
      root_urn: rootUrn,
      depth,
      nodes: [
        {
          id: REGISTRY_AGENT_URN,
          urn: REGISTRY_AGENT_URN,
          entity_type: 'AGENT',
          label: 'Registry Demo Agent',
          properties: { agent_key: 'cursor:registry-agent' },
        },
        {
          id: TAME_LLAMA_URN,
          urn: TAME_LLAMA_URN,
          entity_type: 'SKILL',
          label: 'Tame A Llama',
          properties: { skill_key: 'skill:tame-llama' },
        },
      ],
      edges: [
        {
          id: `${REGISTRY_AGENT_URN}|sg:usesSkill|${TAME_LLAMA_URN}`,
          from_urn: REGISTRY_AGENT_URN,
          to_urn: TAME_LLAMA_URN,
          predicate: 'sg:usesSkill',
          label: 'sg:usesSkill',
        },
      ],
    }),
    listAgents: async () => ({
      agents: [
        {
          agent_urn: REGISTRY_AGENT_URN,
          agent_key: 'cursor:registry-agent',
          harness_name: 'cursor',
          display_name: 'Registry Demo Agent',
          tags: ['platform'],
          trust: { score: 20.9, lifecycle_status: 'published', tier_weight: 2, recency_days: 1, recency_component: 0.9944 },
        },
        {
          agent_urn: SECURITY_AGENT_URN,
          agent_key: 'cursor:signet-security-agent',
          harness_name: 'cursor',
          display_name: 'Signet Security Agent',
        },
      ],
    }),
    getAgent: async (agentKey) =>
      agentKey === 'cursor:registry-agent' ? registryAgentDetails : securityAgentDetails,
    createAgent: async () => registryAgentDetails,
    listSkills: async () => ({
      skills: [
        {
          skill_urn: TAME_LLAMA_URN,
          skill_key: 'skill:tame-llama',
          display_name: 'Tame A Llama',
          source_path: 'client/registry-cli/examples/demo/skills/tame-llama.md',
        },
      ],
    }),
    getSkill: async () => tameLlamaDetails,
    createSkill: async () => ({ skill: tameLlamaDetails.skill, artifacts: [tameLlamaArtifact] }),
    listSkillVersions: async () => ({ versions: [tameLlamaVersion] }),
    getActiveSkillVersion: async () => tameLlamaVersion,
    createSkillDraft: async () => ({
      task: { task: { urn: 'urn:sg:task:1', properties: {} }, targets: [] },
      result: tameLlamaVersion,
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
    listPendingReviews: async () => ({
      pending: [
        {
          publication_urn: 'urn:sg:skill-version:skill:tame-llama@v1',
          entity_type: 'SKILL_VERSION',
          logical_key: 'skill:tame-llama',
          lifecycle_status: 'published',
          review_status: 'pending',
          policy_version: 'registry-policy/v1',
        },
      ],
    }),
    listAgentVersions: async () => ({ versions: [] }),
    reviewSkillVersion: async () => ({
      task: { task: { urn: 'urn:sg:task:review', properties: {} }, targets: [] },
      result: tameLlamaVersion,
    }),
    reviewAgentVersion: async () => ({
      task: { task: { urn: 'urn:sg:task:review', properties: {} }, targets: [] },
      result: tameLlamaVersion,
    }),
    getArtifactJson: async (sha256) =>
      sha256 === 'e'.repeat(64)
        ? {
            payload: {
              validator: 'shacl-v1',
              engine: 'shacl-engine@1.1.3+sparql',
              conforms: true,
              validated_at: '2026-11-15T02:58:23.559Z',
              layers: [{ layer: 'graph_shape', violations: [] }],
            },
          }
        : null,
    getSkillProvenance: async () => ({
      entity: { urn: TAME_LLAMA_URN, entity_type: 'SKILL' },
      derivation_chain: [],
      replay: [
        {
          occurred_at: '2026-11-15T02:58:22.990Z',
          operation: 'create_draft',
          actor: 'registry-operator',
          version_urn: 'urn:sg:skill-version:skill:tame-llama@v1',
          status: 'completed',
        },
        {
          occurred_at: '2026-11-15T02:58:23.559Z',
          operation: 'validate',
          actor: 'registry-operator',
          version_urn: 'urn:sg:skill-version:skill:tame-llama@v1',
          status: 'completed',
        },
      ],
      evidence: {
        canonical_rdf_sha256: 'f'.repeat(64),
        canonical_rdf_artifact_urn: `urn:sg:artifact:sha256:${'f'.repeat(64)}`,
      },
      provenance_signatures: [],
      all_provenance_signatures_verified: false,
      current_provenance_signed: false,
    }),
    getAgentProvenance: async () => ({
      entity: { urn: REGISTRY_AGENT_URN, entity_type: 'AGENT' },
      derivation_chain: [],
      replay: [],
      evidence: {
        canonical_rdf_sha256: 'f'.repeat(64),
        canonical_rdf_artifact_urn: `urn:sg:artifact:sha256:${'f'.repeat(64)}`,
      },
      provenance_signatures: [],
      all_provenance_signatures_verified: false,
      current_provenance_signed: false,
    }),
    searchRegistry: async (input) => ({
      query: input.query,
      mode: input.mode,
      skills:
        input.type === 'agent'
          ? []
          : [
              {
                skill_urn: TAME_LLAMA_URN,
                skill_key: 'skill:tame-llama',
                display_name: 'Tame A Llama',
                trust: {
                  score: 20.9,
                  lifecycle_status: 'published',
                  tier_weight: 2,
                  recency_days: 1,
                  recency_component: 0.9944,
                },
                match: {
                  mode: input.mode,
                  score: 7,
                  matched_claims: ['pii-handling'],
                  matched_terms: ['llama'],
                  phrase_match: false,
                },
              },
            ],
      agents: [],
    }),
    setSkillTags: async (_skillKey, tags) => ({ tags }),
    setAgentTags: async (_agentKey, tags) => ({ tags }),
  };
}

function defaultLifecycleResult(action: string): SkillLifecycleOperationResult {
  return {
    task: {
      task: { urn: `urn:sg:task:${action}`, properties: { action } },
      targets: [],
    },
    result: tameLlamaVersion,
  };
}

// --- the smoke --------------------------------------------------------------

maybeDescribe('knowledge-manager interaction smoke (headless chromium)', { timeout: 90_000 }, () => {
  let server: ServerType;
  let browser: Browser;
  let page: Page;
  let origin: string;

  beforeAll(async () => {
    const app = buildApp({
      env,
      registryApi: makeRegistryApiClient(),
      semanticTurkey: {
        listProjects: async () => ({ status: 'not_configured', projects: [] }),
      } satisfies SemanticTurkeyClient,
      sessionStore: new InMemoryOperatorSessionStore({ ttlMinutes: env.SESSION_TTL_MINUTES }),
    });

    server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve, reject) => {
      server.once('listening', () => resolve());
      server.once('error', reject);
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('interaction smoke: could not determine the app port');
    }
    origin = `http://127.0.0.1:${address.port}`;

    browser = await chromium.launch();
    const context = await browser.newContext({
      colorScheme: 'dark',
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    page = await context.newPage();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('renders the home dashboard with the dark design system applied', async () => {
    await page.goto(`${origin}/`);
    expect(await page.title()).toContain('Knowledge Manager');
    expect(await page.locator('.dashboard .metric').count()).toBe(5);

    const colorScheme = await page.evaluate(
      () => getComputedStyle(document.documentElement).colorScheme,
    );
    expect(colorScheme).toBe('dark');
  });

  it('filters agent rows client-side', async () => {
    await page.goto(`${origin}/agents`);
    const registryRow = page.locator('#filterable-table tbody tr', {
      hasText: 'cursor:registry-agent',
    });
    const securityRow = page.locator('#filterable-table tbody tr', {
      hasText: 'cursor:signet-security-agent',
    });
    expect(await registryRow.isVisible()).toBe(true);
    expect(await securityRow.isVisible()).toBe(true);

    // Trust column: scored agents show the chip, unscored rows show a dash.
    // Tagged rows also carry a tag chip linking into the tag filter.
    expect(await registryRow.locator('.chip').count()).toBe(2);
    expect(((await registryRow.textContent()) ?? '')).toContain('20.9');
    expect(((await registryRow.textContent()) ?? '')).toContain('platform');
    expect(await registryRow.locator('a.chip').getAttribute('href')).toBe('/agents?tag=platform');

    await page.fill('#table-filter', 'security');
    await expect.poll(() => securityRow.isVisible()).toBe(true);
    await expect.poll(() => registryRow.isHidden()).toBe(true);

    await page.fill('#table-filter', '');
    await expect.poll(() => registryRow.isVisible()).toBe(true);
    await expect.poll(() => securityRow.isVisible()).toBe(true);
  });

  it('switches skill detail tabs, exposes lifecycle actions, and copies the URN', async () => {
    await page.goto(`${origin}/skills/skill%3Atame-llama`);
    await page.waitForSelector('.tabs-wrap .tab-btn[data-tab="overview"]');

    const overview = page.locator('[data-tab-panel="overview"]');
    const versions = page.locator('[data-tab-panel="versions"]');
    const artifacts = page.locator('[data-tab-panel="artifacts"]');
    const history = page.locator('[data-tab-panel="history"]');

    expect(await overview.isVisible()).toBe(true);
    expect(await versions.isHidden()).toBe(true);

    // Validation evidence renders in the overview for the active version.
    expect(await overview.locator('.review-evidence').count()).toBeGreaterThan(0);
    expect(((await overview.textContent()) ?? '')).toContain('graph_shape');

    await page.click('.tab-btn[data-tab="versions"]');
    expect(await versions.isVisible()).toBe(true);
    expect(await overview.isHidden()).toBe(true);
    expect(await page.locator('[data-tab-panel="versions"] .version-card').count()).toBe(1);
    expect(
      await page.locator('[data-tab-panel="versions"] .version-card .state-badge', { hasText: 'published' }).count(),
    ).toBeGreaterThan(0);
    expect(
      await page.locator('[data-tab-panel="versions"] button', { hasText: 'Certify' }).count(),
    ).toBe(1);

    await page.click('.tab-btn[data-tab="artifacts"]');
    expect(await artifacts.isVisible()).toBe(true);
    expect(await versions.isHidden()).toBe(true);

    await page.click('.tab-btn[data-tab="history"]');
    expect(await history.isVisible()).toBe(true);
    expect(await history.locator('.timeline .timeline-item').count()).toBe(2);
    expect(((await history.textContent()) ?? '')).toContain('create_draft');
    expect(((await history.textContent()) ?? '')).toContain('registry-operator');

    await page.click('.detail-hero .detail-urn .copy-btn');
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(TAME_LLAMA_URN);
  });

  it('renders the graph explorer canvas and the selected-node panel', async () => {
    await page.goto(`${origin}/graph`);
    await page.waitForSelector('#graph-canvas canvas', { timeout: 20_000 });
    expect(await page.locator('#graph-canvas canvas').count()).toBeGreaterThan(0);
    await expect
      .poll(async () => (await page.locator('#graph-detail-panel').textContent()) ?? '')
      .toContain('Registry Demo Agent');
  });

  it('renders semantic search results with match components', async () => {
    await page.goto(`${origin}/skills?q=llama&mode=semantic`);
    await page.waitForSelector('#filterable-table tbody tr');
    const row = page.locator('#filterable-table tbody tr').first();
    const rowText = (await row.textContent()) ?? '';
    expect(rowText).toContain('skill:tame-llama');
    expect(rowText).toContain('pii-handling');
    expect(rowText).toContain('semantic 7');
    expect(((await page.textContent('body')) ?? '')).toContain('relevance-ordered');
  });

  it('renders the review queue with approve and reject controls', async () => {
    await page.goto(`${origin}/reviews`);
    await page.waitForSelector('.review-card');
    expect(await page.locator('.review-card').count()).toBe(1);
    expect((await page.locator('.review-card').textContent()) ?? '').toContain('skill:tame-llama');
    expect(await page.locator('.review-card button', { hasText: 'Approve' }).count()).toBe(1);
    expect(await page.locator('.review-card button', { hasText: 'Reject' }).count()).toBe(1);
  });

  it('renders the api-key login card', async () => {
    await page.goto(`${origin}/login`);
    expect(await page.locator('.auth-card').isVisible()).toBe(true);
    expect(await page.locator('.auth-card input[name="api_token"]').count()).toBe(1);
    expect(await page.locator('.auth-card button', { hasText: 'Start session' }).count()).toBe(1);
  });
});
