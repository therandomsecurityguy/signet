import { describe, expect, it } from 'vitest';

import {
  assertResetAllowed,
  buildAgentCreatePlan,
  buildSkillSeedPlan,
  collectSparqlTargets,
  detectGraphBackend,
  normalizeHostFacingUrl,
  parseArgs,
  resolveBootstrapManifest,
  validateOktaConfig,
} from '../src/operator.js';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

describe('registry operator parsing and planning', () => {
  it('parses bootstrap test flags', () => {
    expect(parseArgs(['bootstrap', 'test', '--manifest', 'foo.json', '--reset', '--force', '--up'])).toEqual({
      group: 'bootstrap',
      action: 'test',
      args: {
        manifest: 'foo.json',
        reset: true,
        force: true,
        up: true,
      },
    });
  });

  it('parses the transparency sample seed command', () => {
    expect(parseArgs(['seed', 'transparency-sample', '--api-token', 'tok', '--sample-slug', 'demo'])).toEqual({
      group: 'seed',
      action: 'transparency-sample',
      args: {
        'api-token': 'tok',
        'sample-slug': 'demo',
      },
    });
  });

  it('parses the okta verification commands', () => {
    expect(parseArgs(['verify', 'okta-config'])).toEqual({
      group: 'verify',
      action: 'okta-config',
      args: {},
    });
    expect(parseArgs(['verify', 'browser-session', '--manifest', 'foo.json'])).toEqual({
      group: 'verify',
      action: 'browser-session',
      args: {
        manifest: 'foo.json',
      },
    });
  });

  it('validates the expected okta config surfaces', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'registry-operator-okta-'));
    try {
      const apiEnvDir = path.join(tmp, 'service', 'api', 'infra');
      const webappEnvDir = path.join(tmp, 'service', 'webapp', 'knowledge-manager', 'infra');
      await mkdir(apiEnvDir, { recursive: true });
      await mkdir(webappEnvDir, { recursive: true });

      await writeFile(
        path.join(apiEnvDir, '.env'),
        [
          'AUTH_MODE=dual',
          'OKTA_MODE=real',
          'OKTA_ISSUER=https://example.okta.com/oauth2/default',
          'OKTA_AUDIENCE=api://agent-registry',
          'OKTA_REQUIRED_SCOPES=registry.write',
          'OKTA_GROUPS_CLAIM=groups',
        ].join('\n'),
      );
      await writeFile(
        path.join(webappEnvDir, '.env'),
        [
          'DATABASE_URL=file:/workspace/data/webapp/knowledge-manager.db',
          'AUTH_MODE=dual',
          'OKTA_MODE=real',
          'OKTA_ISSUER=https://example.okta.com/oauth2/default',
          'OKTA_CLIENT_ID=webapp-client',
          'OKTA_REDIRECT_URI=http://localhost:3200/session/callback',
          'OKTA_SCOPES=openid profile email',
        ].join('\n'),
      );

      const result = await validateOktaConfig({
        API_ORIGIN: 'http://localhost:3100',
        MCP_ORIGIN: 'http://localhost:3000',
        WEBAPP_ORIGIN: 'http://localhost:3200',
        REPO_ROOT: tmp,
        API_ENV_FILE: path.join(apiEnvDir, '.env'),
        WEBAPP_ENV_FILE: path.join(webappEnvDir, '.env'),
        MCP_ENV_FILE: path.join(tmp, 'service', 'mcp', 'infra', '.env'),
      });

      expect(result).toMatchObject({
        ok: true,
        api_mode: 'dual',
        webapp_mode: 'dual',
        api_missing: [],
        webapp_missing: [],
      });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('builds lifecycle-aware skill seed plans', () => {
    const plan = buildSkillSeedPlan(
      {
        skill_key: 'skill:example',
        author: 'jane',
        artifact_path: 'skills/example.md',
        artifact_media_type: 'text/markdown',
        certify: true,
        validate_note: 'validate',
        publish_note: 'publish',
        certify_note: 'certify',
      },
      '/repo/bootstrap',
    );

    expect(plan).toMatchObject({
      draft: {
        skill_key: 'skill:example',
        author: 'jane',
        artifact_path: '/repo/bootstrap/skills/example.md',
        source_path: 'skills/example.md',
      },
      certify: true,
      validateNote: 'validate',
      publishNote: 'publish',
      certifyNote: 'certify',
    });
  });

  it('builds agent create plans with normalized skill refs', () => {
    const plan = buildAgentCreatePlan(
      {
        agent_key: 'cursor:example',
        artifact_path: 'agents/example.md',
        artifact_media_type: 'text/markdown',
        skill_refs: ['skill:example', 'urn:sg:skill:skill:other'],
      },
      '/repo/bootstrap',
    );

    expect(plan).toMatchObject({
      agent_key: 'cursor:example',
      artifact_path: '/repo/bootstrap/agents/example.md',
      source_path: 'agents/example.md',
      skill_refs: [{ skill_key: 'skill:example' }, { skill_urn: 'urn:sg:skill:skill:other' }],
    });
  });

  it('resolves richer bootstrap manifests with defaults, profiles, and dependency order', () => {
    const resolved = resolveBootstrapManifest(
      {
        pack: {
          pack_id: 'pack-1',
          version: '0.1.0',
          tags: ['bootstrap'],
        },
        defaults: {
          skill: {
            author: 'operator',
            artifact_media_type: 'text/markdown',
          },
          agent: {
            harness_name: 'cursor',
          },
        },
        profiles: {
          minimal: {
            skill_item_ids: ['skill_base'],
            agent_item_ids: ['agent_one'],
          },
        },
        skills: [
          {
            item_id: 'skill_base',
            skill_key: 'skill:base',
            artifact_path: 'skills/base.md',
          },
          {
            item_id: 'skill_extra',
            skill_key: 'skill:extra',
            artifact_path: 'skills/extra.md',
            depends_on: ['skill_base'],
          },
        ],
        agents: [
          {
            item_id: 'agent_two',
            agent_key: 'cursor:two',
            artifact_path: 'agents/two.md',
            depends_on: ['agent_one', 'skill_extra'],
            skill_refs: [{ skill_item_id: 'skill_extra' }],
          },
          {
            item_id: 'agent_one',
            agent_key: 'cursor:one',
            artifact_path: 'agents/one.md',
            skill_refs: [{ skill_item_id: 'skill_base' }],
          },
        ],
      },
      '/repo/bootstrap/bootstrap.manifest.json',
    );

    expect(resolved.skills.map((skill) => skill.itemId)).toEqual(['skill_base', 'skill_extra']);
    expect(resolved.agents.map((agent) => agent.itemId)).toEqual(['agent_one', 'agent_two']);
    expect(resolved.skills[0]).toMatchObject({
      draft: {
        author: 'operator',
        artifact_media_type: 'text/markdown',
        artifact_path: '/repo/bootstrap/skills/base.md',
      },
    });
    expect(resolved.agents[0]).toMatchObject({
      harness_name: 'cursor',
      skill_refs: [{ skill_key: 'skill:base' }],
    });

    const minimal = resolveBootstrapManifest(
      {
        pack: {
          pack_id: 'pack-1',
          version: '0.1.0',
          tags: ['bootstrap'],
        },
        defaults: {
          skill: {
            author: 'operator',
          },
          agent: {
            harness_name: 'cursor',
          },
        },
        profiles: {
          minimal: {
            skill_item_ids: ['skill_base'],
            agent_item_ids: ['agent_one'],
          },
        },
        skills: [
          {
            item_id: 'skill_base',
            skill_key: 'skill:base',
            artifact_path: 'skills/base.md',
          },
          {
            item_id: 'skill_extra',
            skill_key: 'skill:extra',
            artifact_path: 'skills/extra.md',
          },
        ],
        agents: [
          {
            item_id: 'agent_one',
            agent_key: 'cursor:one',
            artifact_path: 'agents/one.md',
            skill_refs: [{ skill_item_id: 'skill_base' }],
          },
        ],
      },
      '/repo/bootstrap/bootstrap.manifest.json',
      { profile: 'minimal' },
    );

    expect(minimal.profile).toBe('minimal');
    expect(minimal.skills).toHaveLength(1);
    expect(minimal.agents).toHaveLength(1);
  });

  it('requires force for reset', () => {
    expect(() => assertResetAllowed({})).toThrow('Refusing to reset local state without --force.');
    expect(() => assertResetAllowed({ force: true })).not.toThrow();
  });

  it('normalizes container graph urls to host-facing urls', () => {
    expect(normalizeHostFacingUrl('http://registry-graph:3030/registry/sparql')).toBe(
      'http://localhost:3030/registry/sparql',
    );
    expect(normalizeHostFacingUrl('http://localhost:3030/registry/sparql')).toBe(
      'http://localhost:3030/registry/sparql',
    );
  });

  it('collects unique sparql targets for reset/readiness work', () => {
    expect(
      collectSparqlTargets([
        {
          backend: 'sparql',
          sparql_query_url: 'http://registry-graph:3030/registry/sparql',
          sparql_update_url: 'http://registry-graph:3030/registry/update',
          sparql_username: 'admin',
          sparql_password: 'admin',
        },
        {
          backend: 'sparql',
          sparql_query_url: 'http://registry-graph:3030/registry/sparql',
          sparql_update_url: 'http://registry-graph:3030/registry/update',
          sparql_username: 'admin',
          sparql_password: 'admin',
        },
        {
          backend: 'json_file',
        },
      ]),
    ).toEqual([
      {
        queryUrl: 'http://localhost:3030/registry/sparql',
        updateUrl: 'http://localhost:3030/registry/update',
        username: 'admin',
        password: 'admin',
      },
    ]);
  });

  it('reports a jena-first graph lane from env files', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'registry-operator-graph-'));
    try {
      const apiEnvDir = path.join(tmp, 'service', 'api', 'infra');
      const mcpEnvDir = path.join(tmp, 'service', 'mcp', 'infra');
      await mkdir(apiEnvDir, { recursive: true });
      await mkdir(mcpEnvDir, { recursive: true });

      await writeFile(
        path.join(apiEnvDir, '.env'),
        [
          'REGISTRY_GRAPH_BACKEND=sparql',
          'REGISTRY_SPARQL_QUERY_URL=http://registry-graph:3030/registry/sparql',
          'REGISTRY_SPARQL_UPDATE_URL=http://registry-graph:3030/registry/update',
        ].join('\n'),
      );
      await writeFile(
        path.join(mcpEnvDir, '.env'),
        [
          'REGISTRY_GRAPH_BACKEND=sparql',
          'REGISTRY_SPARQL_QUERY_URL=http://registry-graph:3030/registry/sparql',
          'REGISTRY_SPARQL_UPDATE_URL=http://registry-graph:3030/registry/update',
        ].join('\n'),
      );

      const result = await detectGraphBackend({
        API_ORIGIN: 'http://localhost:3100',
        MCP_ORIGIN: 'http://localhost:3000',
        WEBAPP_ORIGIN: 'http://localhost:3200',
        REPO_ROOT: tmp,
        API_ENV_FILE: path.join(apiEnvDir, '.env'),
        WEBAPP_ENV_FILE: path.join(tmp, 'service', 'webapp', 'knowledge-manager', 'infra', '.env'),
        MCP_ENV_FILE: path.join(mcpEnvDir, '.env'),
      });

      expect(result).toMatchObject({
        lane: 'jena-first',
        api: {
          backend: 'sparql',
          sparql_query_url: 'http://localhost:3030/registry/sparql',
        },
        mcp: {
          backend: 'sparql',
          sparql_update_url: 'http://localhost:3030/registry/update',
        },
      });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
