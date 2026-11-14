import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { ServerType } from '@hono/node-server';
import { serve } from '@hono/node-server';

import { runCli } from '../src/operator.js';
import { loadEnv as loadApiEnv } from '../../../service/api/src/infrastructure/config/env.js';
import { buildAppDependencies as buildApiDependencies } from '../../../service/api/src/app/dependencies.js';
import { buildApp as buildApiApp } from '../../../service/api/src/app/server.js';
import { loadEnv as loadMcpEnv } from '../../../service/mcp/src/infrastructure/config/env.js';
import { buildAppDependencies as buildMcpDependencies } from '../../../service/mcp/src/app/dependencies.js';
import { buildApp as buildMcpApp } from '../../../service/mcp/src/app/server.js';

const servers: ServerType[] = [];
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// This suite boots real API/MCP servers and seeds through the CLI; on CI
// runners individual tests take 5-9s and trip the 5s vitest default.
vi.setConfig({ testTimeout: 30_000 });

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

describe('registry-operator bootstrap test command', () => {
  it('seeds skills and agents through API and verifies discovery/load through MCP', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'registry-operator-bootstrap-'));
    const previousEnv = {
      API_ORIGIN: process.env.API_ORIGIN,
      MCP_ORIGIN: process.env.MCP_ORIGIN,
      WEBAPP_ORIGIN: process.env.WEBAPP_ORIGIN,
      REPO_ROOT: process.env.REPO_ROOT,
    };

    try {
      const graphStateFile = path.join(tmp, 'graph', 'registry-state.json');
      const objectsDir = path.join(tmp, 'objects');
      const apiEnv = loadApiEnv({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        AUTH_MODE: 'api_key',
        DATABASE_URL: `file:${path.join(tmp, 'api.db')}`,
        REGISTRY_GRAPH_BACKEND: 'json_file',
        REGISTRY_GRAPH_STATE_FILE: graphStateFile,
        REGISTRY_OBJECTS_DIR: objectsDir,
        TIME_AWARE_GRAPH_BACKEND: 'memory',
        TIME_AWARE_OBJECTS_DIR: path.join(tmp, 'time-aware-objects'),
      });
      const apiDeps = buildApiDependencies(apiEnv);
      await apiDeps.ready();
      const api = buildApiApp(apiDeps);
      const apiServer = await startServer(api.fetch as unknown as FetchHandler);

      const mcpEnv = loadMcpEnv({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        AUTH_MODE: 'api_key',
        DATABASE_URL: `file:${path.join(tmp, 'mcp.db')}`,
        REGISTRY_GRAPH_BACKEND: 'json_file',
        REGISTRY_GRAPH_STATE_FILE: graphStateFile,
        REGISTRY_OBJECTS_DIR: objectsDir,
      });
      const mcpDeps = buildMcpDependencies(mcpEnv);
      await mcpDeps.ready();
      const mcp = buildMcpApp(mcpDeps);
      const mcpServer = await startServer(mcp.fetch as unknown as FetchHandler);

      const { token: apiToken } = await apiDeps.apiKeys.create({ owner_label: 'Bootstrap API' });
      const { token: mcpToken } = await mcpDeps.apiKeys.create({ owner_label: 'Bootstrap MCP' });

      const manifestPath = path.join(tmp, 'bootstrap.manifest.json');
      await mkdir(path.join(tmp, 'skills'), { recursive: true });
      await mkdir(path.join(tmp, 'agents'), { recursive: true });
      await writeFile(path.join(tmp, 'skills', 'bootstrap-example.md'), '# Bootstrap Skill\n');
      await writeFile(path.join(tmp, 'agents', 'bootstrap-agent.md'), '# Bootstrap Agent\n');
      await writeFile(
        manifestPath,
        JSON.stringify(
          {
            pack: {
              pack_id: 'bootstrap-pack-test',
              version: '0.1.0',
              tags: ['integration'],
            },
            defaults: {
              skill: {
                author: 'integration',
                artifact_media_type: 'text/markdown',
              },
              agent: {
                artifact_media_type: 'text/markdown',
              },
            },
            profiles: {
              full: {
                skill_item_ids: ['skill_base', 'skill_extra'],
                agent_item_ids: ['agent_cursor', 'agent_claude'],
              },
            },
            skills: [
              {
                item_id: 'skill_base',
                skill_key: 'skill:bootstrap-integration',
                artifact_path: 'skills/bootstrap-example.md',
                certify: true,
              },
              {
                item_id: 'skill_extra',
                skill_key: 'skill:bootstrap-extra',
                artifact_path: 'skills/bootstrap-example.md',
                depends_on: ['skill_base'],
              },
            ],
            agents: [
              {
                item_id: 'agent_cursor',
                agent_key: 'cursor:bootstrap-integration',
                harness_name: 'cursor',
                artifact_path: 'agents/bootstrap-agent.md',
                skill_refs: [{ skill_item_id: 'skill_base' }],
              },
              {
                item_id: 'agent_claude',
                agent_key: 'claudecode:bootstrap-extra',
                harness_name: 'claudecode',
                artifact_path: 'agents/bootstrap-agent.md',
                depends_on: ['agent_cursor', 'skill_extra'],
                skill_refs: [{ skill_item_id: 'skill_base' }, { skill_item_id: 'skill_extra' }],
              },
            ],
          },
          null,
          2,
        ),
      );

      process.env.API_ORIGIN = apiServer.baseUrl;
      process.env.MCP_ORIGIN = mcpServer.baseUrl;
      process.env.REPO_ROOT = repoRoot;

      await runCli([
        'bootstrap',
        'test',
        '--manifest',
        manifestPath,
        '--profile',
        'full',
        '--api-token',
        apiToken,
        '--mcp-token',
        mcpToken,
      ]);

      // WS3.2: verify a seeded publication end to end (server verdict plus
      // client-side digest and signature checks), and verify its artifact
      // bytes locally.
      await runCli(['verify', 'publication', '--skill', 'skill:bootstrap-integration', '--version', '1']);

      // The seeded publication carries no signatures, so strict mode fails
      // by design.
      await expect(
        runCli(['verify', 'publication', '--skill', 'skill:bootstrap-integration', '--version', '1', '--strict']),
      ).rejects.toThrow('Publication did not verify.');

      const skillVersionRes = await api.request('/v1/skills/skill%3Abootstrap-integration/versions/1');
      const skillVersionBody = (await skillVersionRes.json()) as { artifacts: Array<{ sha256?: string }> };
      const artifactSha = skillVersionBody.artifacts[0]?.sha256;
      expect(artifactSha).toBeTruthy();
      await runCli(['verify', 'artifact', '--sha256', artifactSha as string]);
      await runCli(['verify', 'artifact', '--artifact-urn', `urn:tg:artifact:sha256:${artifactSha as string}`]);

      const agentRes = await api.request('/v1/agents/cursor%3Abootstrap-integration');
      expect(agentRes.status).toBe(200);
      const agentTwoRes = await api.request('/v1/agents/claudecode%3Abootstrap-extra');
      expect(agentTwoRes.status).toBe(200);
      const skillActiveRes = await api.request('/v1/skills/skill%3Abootstrap-integration/active');
      expect(skillActiveRes.status).toBe(200);
      const skillTwoActiveRes = await api.request('/v1/skills/skill%3Abootstrap-extra/active');
      expect(skillTwoActiveRes.status).toBe(200);
    } finally {
      restoreEnvVar('API_ORIGIN', previousEnv.API_ORIGIN);
      restoreEnvVar('MCP_ORIGIN', previousEnv.MCP_ORIGIN);
      restoreEnvVar('WEBAPP_ORIGIN', previousEnv.WEBAPP_ORIGIN);
      restoreEnvVar('REPO_ROOT', previousEnv.REPO_ROOT);
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('seeds real detached signatures when signing is enabled and verifies strictly', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'registry-operator-signing-'));
    const previousEnv = {
      API_ORIGIN: process.env.API_ORIGIN,
      MCP_ORIGIN: process.env.MCP_ORIGIN,
      WEBAPP_ORIGIN: process.env.WEBAPP_ORIGIN,
      REPO_ROOT: process.env.REPO_ROOT,
    };

    try {
      const graphStateFile = path.join(tmp, 'graph', 'registry-state.json');
      const objectsDir = path.join(tmp, 'objects');
      const apiEnv = loadApiEnv({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        AUTH_MODE: 'api_key',
        DATABASE_URL: `file:${path.join(tmp, 'api.db')}`,
        REGISTRY_GRAPH_BACKEND: 'json_file',
        REGISTRY_GRAPH_STATE_FILE: graphStateFile,
        REGISTRY_OBJECTS_DIR: objectsDir,
        TIME_AWARE_GRAPH_BACKEND: 'memory',
        TIME_AWARE_OBJECTS_DIR: path.join(tmp, 'time-aware-objects'),
      });
      const apiDeps = buildApiDependencies(apiEnv);
      await apiDeps.ready();
      const api = buildApiApp(apiDeps);
      const apiServer = await startServer(api.fetch as unknown as FetchHandler);
      const { token: apiToken } = await apiDeps.apiKeys.create({ owner_label: 'Signing API' });

      const manifestPath = path.join(tmp, 'signing.manifest.json');
      await mkdir(path.join(tmp, 'skills'), { recursive: true });
      await writeFile(path.join(tmp, 'skills', 'signing-example.md'), '# Signing Skill\n');
      await writeFile(
        manifestPath,
        JSON.stringify(
          {
            pack: { pack_id: 'signing-pack-test', version: '0.1.0', tags: ['integration'] },
            defaults: { skill: { author: 'registry-operator', artifact_media_type: 'text/markdown' } },
            signing: { enabled: true, owner: 'registry-operator' },
            skills: [
              {
                item_id: 'skill_signed',
                skill_key: 'skill:integration-signed',
                artifact_path: 'skills/signing-example.md',
              },
            ],
            agents: [],
          },
          null,
          2,
        ),
      );

      process.env.API_ORIGIN = apiServer.baseUrl;
      process.env.MCP_ORIGIN = apiServer.baseUrl;
      process.env.REPO_ROOT = tmp;

      await runCli(['seed', 'bootstrap', '--manifest', manifestPath, '--api-token', apiToken]);

      const envelopeRes = await api.request('/v1/skills/skill%3Aintegration-signed/versions/1/publication-envelope');
      expect(envelopeRes.status).toBe(200);
      const envelope = (await envelopeRes.json()) as {
        detached_signatures: Array<{ key_ref: string; signer: string }>;
      };
      expect(envelope.detached_signatures).toHaveLength(1);
      expect(envelope.detached_signatures[0]).toMatchObject({
        key_ref: 'demo://cachet/demo-signing-key',
        signer: 'registry-operator',
      });

      // Strict verification passes for a signed publication.
      await runCli(['verify', 'publication', '--skill', 'skill:integration-signed', '--version', '1', '--strict']);

      // Re-seeding is idempotent: the same demo key does not sign twice.
      await runCli(['seed', 'bootstrap', '--manifest', manifestPath, '--api-token', apiToken]);
      const afterRes = await api.request('/v1/skills/skill%3Aintegration-signed/versions/1/publication-envelope');
      const after = (await afterRes.json()) as { detached_signatures: unknown[] };
      expect(after.detached_signatures).toHaveLength(1);
    } finally {
      restoreEnvVar('API_ORIGIN', previousEnv.API_ORIGIN);
      restoreEnvVar('MCP_ORIGIN', previousEnv.MCP_ORIGIN);
      restoreEnvVar('WEBAPP_ORIGIN', previousEnv.WEBAPP_ORIGIN);
      restoreEnvVar('REPO_ROOT', previousEnv.REPO_ROOT);
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('includes the okta-browser verification lane details when requested', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'registry-operator-okta-lane-'));
    const previousEnv = {
      API_ORIGIN: process.env.API_ORIGIN,
      MCP_ORIGIN: process.env.MCP_ORIGIN,
      WEBAPP_ORIGIN: process.env.WEBAPP_ORIGIN,
      REPO_ROOT: process.env.REPO_ROOT,
      API_ENV_FILE: process.env.API_ENV_FILE,
      WEBAPP_ENV_FILE: process.env.WEBAPP_ENV_FILE,
    };

    try {
      const graphStateFile = path.join(tmp, 'graph', 'registry-state.json');
      const objectsDir = path.join(tmp, 'objects');
      const apiEnv = loadApiEnv({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        AUTH_MODE: 'api_key',
        DATABASE_URL: `file:${path.join(tmp, 'api.db')}`,
        REGISTRY_GRAPH_BACKEND: 'json_file',
        REGISTRY_GRAPH_STATE_FILE: graphStateFile,
        REGISTRY_OBJECTS_DIR: objectsDir,
        TIME_AWARE_GRAPH_BACKEND: 'memory',
        TIME_AWARE_OBJECTS_DIR: path.join(tmp, 'time-aware-objects'),
      });
      const apiDeps = buildApiDependencies(apiEnv);
      await apiDeps.ready();
      const api = buildApiApp(apiDeps);
      const apiServer = await startServer(api.fetch as unknown as FetchHandler);

      const mcpEnv = loadMcpEnv({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        AUTH_MODE: 'api_key',
        DATABASE_URL: `file:${path.join(tmp, 'mcp.db')}`,
        REGISTRY_GRAPH_BACKEND: 'json_file',
        REGISTRY_GRAPH_STATE_FILE: graphStateFile,
        REGISTRY_OBJECTS_DIR: objectsDir,
      });
      const mcpDeps = buildMcpDependencies(mcpEnv);
      await mcpDeps.ready();
      const mcp = buildMcpApp(mcpDeps);
      const mcpServer = await startServer(mcp.fetch as unknown as FetchHandler);

      const manifestPath = path.join(tmp, 'bootstrap.manifest.json');
      const apiEnvDir = path.join(tmp, 'service', 'api', 'infra');
      const webappEnvDir = path.join(tmp, 'service', 'webapp', 'knowledge-manager', 'infra');
      await mkdir(apiEnvDir, { recursive: true });
      await mkdir(webappEnvDir, { recursive: true });
      await mkdir(path.join(tmp, 'skills'), { recursive: true });
      await mkdir(path.join(tmp, 'agents'), { recursive: true });
      await writeFile(path.join(tmp, 'skills', 'bootstrap-example.md'), '# Bootstrap Skill\n');
      await writeFile(path.join(tmp, 'agents', 'bootstrap-agent.md'), '# Bootstrap Agent\n');
      await writeFile(
        manifestPath,
        JSON.stringify(
          {
            skills: [
              {
                item_id: 'skill_base',
                skill_key: 'skill:bootstrap-okta',
                author: 'integration',
                artifact_path: 'skills/bootstrap-example.md'
              }
            ],
            agents: [
              {
                item_id: 'agent_cursor',
                agent_key: 'cursor:bootstrap-okta',
                artifact_path: 'agents/bootstrap-agent.md',
                skill_refs: [{ skill_item_id: 'skill_base' }]
              }
            ]
          },
          null,
          2,
        ),
      );

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

      const { token: apiToken } = await apiDeps.apiKeys.create({ owner_label: 'Bootstrap API' });
      const { token: mcpToken } = await mcpDeps.apiKeys.create({ owner_label: 'Bootstrap MCP' });

      process.env.API_ORIGIN = apiServer.baseUrl;
      process.env.MCP_ORIGIN = mcpServer.baseUrl;
      process.env.WEBAPP_ORIGIN = 'http://localhost:3200';
      process.env.REPO_ROOT = repoRoot;
      process.env.API_ENV_FILE = path.join(apiEnvDir, '.env');
      process.env.WEBAPP_ENV_FILE = path.join(webappEnvDir, '.env');

      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (value?: unknown) => {
        logs.push(String(value));
      };
      try {
        await runCli([
          'bootstrap',
          'test',
          '--lane',
          'okta-browser',
          '--manifest',
          manifestPath,
          '--api-token',
          apiToken,
          '--mcp-token',
          mcpToken,
        ]);
      } finally {
        console.log = originalLog;
      }

      const combined = logs.join('\n');
      expect(combined).toContain('"lane": "okta-browser"');
      expect(combined).toContain('"okta_lane"');
      expect(combined).toContain('OKTA_BROWSER_FLOW_RUNBOOK.md');
    } finally {
      restoreEnvVar('API_ORIGIN', previousEnv.API_ORIGIN);
      restoreEnvVar('MCP_ORIGIN', previousEnv.MCP_ORIGIN);
      restoreEnvVar('WEBAPP_ORIGIN', previousEnv.WEBAPP_ORIGIN);
      restoreEnvVar('REPO_ROOT', previousEnv.REPO_ROOT);
      restoreEnvVar('API_ENV_FILE', previousEnv.API_ENV_FILE);
      restoreEnvVar('WEBAPP_ENV_FILE', previousEnv.WEBAPP_ENV_FILE);
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('prints blessed demo handoff details and writes token-safe run artifacts', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'registry-operator-demo-output-'));
    const previousEnv = {
      API_ORIGIN: process.env.API_ORIGIN,
      MCP_ORIGIN: process.env.MCP_ORIGIN,
      WEBAPP_ORIGIN: process.env.WEBAPP_ORIGIN,
      REPO_ROOT: process.env.REPO_ROOT,
    };

    try {
      const graphStateFile = path.join(tmp, 'graph', 'registry-state.json');
      const objectsDir = path.join(tmp, 'objects');
      const apiEnv = loadApiEnv({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        AUTH_MODE: 'api_key',
        DATABASE_URL: `file:${path.join(tmp, 'api.db')}`,
        REGISTRY_GRAPH_BACKEND: 'json_file',
        REGISTRY_GRAPH_STATE_FILE: graphStateFile,
        REGISTRY_OBJECTS_DIR: objectsDir,
        TIME_AWARE_GRAPH_BACKEND: 'memory',
        TIME_AWARE_OBJECTS_DIR: path.join(tmp, 'time-aware-objects'),
      });
      const apiDeps = buildApiDependencies(apiEnv);
      await apiDeps.ready();
      const api = buildApiApp(apiDeps);
      const apiServer = await startServer(api.fetch as unknown as FetchHandler);

      const mcpEnv = loadMcpEnv({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        AUTH_MODE: 'api_key',
        DATABASE_URL: `file:${path.join(tmp, 'mcp.db')}`,
        REGISTRY_GRAPH_BACKEND: 'json_file',
        REGISTRY_GRAPH_STATE_FILE: graphStateFile,
        REGISTRY_OBJECTS_DIR: objectsDir,
      });
      const mcpDeps = buildMcpDependencies(mcpEnv);
      await mcpDeps.ready();
      const mcp = buildMcpApp(mcpDeps);
      const mcpServer = await startServer(mcp.fetch as unknown as FetchHandler);

      const manifestPath = path.join(tmp, 'demo.manifest.json');
      await mkdir(path.join(tmp, 'skills'), { recursive: true });
      await mkdir(path.join(tmp, 'agents'), { recursive: true });
      await writeFile(path.join(tmp, 'skills', 'registry-mcp.md'), '# Registry MCP Skill\n');
      await writeFile(path.join(tmp, 'skills', 'tame-llama.md'), '# Tame Llama Skill\n');
      await writeFile(path.join(tmp, 'agents', 'registry-agent.md'), '# Registry Agent\n');
      await writeFile(
        manifestPath,
        JSON.stringify(
          {
            pack: {
              pack_id: 'blessed-first-user-demo',
              version: '0.1.0',
              tags: ['demo'],
            },
            defaults: {
              skill: {
                author: 'integration',
                artifact_media_type: 'text/markdown',
              },
              agent: {
                artifact_media_type: 'text/markdown',
              },
            },
            skills: [
              {
                item_id: 'skill_registry_mcp',
                skill_key: 'skill:registry-mcp',
                artifact_path: 'skills/registry-mcp.md',
              },
              {
                item_id: 'skill_tame_llama',
                skill_key: 'skill:tame-llama',
                artifact_path: 'skills/tame-llama.md',
              },
            ],
            agents: [
              {
                item_id: 'agent_registry',
                agent_key: 'cursor:registry-agent',
                harness_name: 'cursor',
                artifact_path: 'agents/registry-agent.md',
                skill_refs: [{ skill_item_id: 'skill_registry_mcp' }, { skill_item_id: 'skill_tame_llama' }],
              },
            ],
          },
          null,
          2,
        ),
      );

      const { token: apiToken } = await apiDeps.apiKeys.create({ owner_label: 'Bootstrap API' });
      const { token: mcpToken } = await mcpDeps.apiKeys.create({ owner_label: 'Bootstrap MCP' });

      process.env.API_ORIGIN = apiServer.baseUrl;
      process.env.MCP_ORIGIN = mcpServer.baseUrl;
      process.env.WEBAPP_ORIGIN = 'http://localhost:3200';
      process.env.REPO_ROOT = tmp;

      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (value?: unknown) => {
        logs.push(String(value));
      };
      try {
        await runCli([
          'bootstrap',
          'test',
          '--manifest',
          manifestPath,
          '--api-token',
          apiToken,
          '--mcp-token',
          mcpToken,
        ]);
      } finally {
        console.log = originalLog;
      }

      const output = JSON.parse(logs.at(-1) ?? '{}') as {
        cursor_mcp_config?: { mcpServers?: { 'agents-registry'?: { url?: string } } };
        next_prompts?: string[];
        mock_okta_demo_command?: string;
        artifacts?: { report_file?: string; resume_file?: string };
      };
      expect(output.cursor_mcp_config?.mcpServers?.['agents-registry']?.url).toBe(`${mcpServer.baseUrl}/mcp`);
      expect(output.next_prompts).toContain('Now answer: How do we tame a llama?');
      expect(output.mock_okta_demo_command).toContain('demo:mock-okta');
      expect(output.artifacts?.report_file).toBeTruthy();
      expect(output.artifacts?.resume_file).toBeTruthy();

      const report = await readFile(output.artifacts?.report_file ?? '', 'utf8');
      expect(report).toContain('"Authorization": "[REDACTED]"');
      expect(report).not.toContain(apiToken);
      expect(report).not.toContain(mcpToken);
    } finally {
      restoreEnvVar('API_ORIGIN', previousEnv.API_ORIGIN);
      restoreEnvVar('MCP_ORIGIN', previousEnv.MCP_ORIGIN);
      restoreEnvVar('WEBAPP_ORIGIN', previousEnv.WEBAPP_ORIGIN);
      restoreEnvVar('REPO_ROOT', previousEnv.REPO_ROOT);
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('seeds the transparency sample graph through the CLI and exposes verification and timeline surfaces', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'registry-operator-transparency-'));
    const previousEnv = {
      API_ORIGIN: process.env.API_ORIGIN,
      REPO_ROOT: process.env.REPO_ROOT,
    };

    try {
      const graphStateFile = path.join(tmp, 'graph', 'registry-state.json');
      const objectsDir = path.join(tmp, 'objects');
      const apiEnv = loadApiEnv({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        AUTH_MODE: 'api_key',
        DATABASE_URL: `file:${path.join(tmp, 'api.db')}`,
        REGISTRY_GRAPH_BACKEND: 'json_file',
        REGISTRY_GRAPH_STATE_FILE: graphStateFile,
        REGISTRY_OBJECTS_DIR: objectsDir,
        TIME_AWARE_GRAPH_BACKEND: 'memory',
        TIME_AWARE_OBJECTS_DIR: path.join(tmp, 'time-aware-objects'),
      });
      const apiDeps = buildApiDependencies(apiEnv);
      await apiDeps.ready();
      const api = buildApiApp(apiDeps);
      const apiServer = await startServer(api.fetch as unknown as FetchHandler);
      const { token: apiToken } = await apiDeps.apiKeys.create({ owner_label: 'Transparency CLI' });

      process.env.API_ORIGIN = apiServer.baseUrl;
      process.env.REPO_ROOT = repoRoot;

      await runCli([
        'seed',
        'transparency-sample',
        '--api-token',
        apiToken,
        '--sample-slug',
        'cli-integration',
        '--day',
        '2026-01-06',
      ]);

      const verification = await api.request('/v1/transparency-logs/tg-cli-integration-log/verification');
      expect(verification.status).toBe(200);
      await expect(verification.json()).resolves.toMatchObject({
        witness_quorum_required: 2,
        witness_quorum_met: true,
        verification_status: 'consistency_failure',
        observations: expect.arrayContaining([
          expect.objectContaining({
            observed_from_id: 'observer-beta',
            source_channel: 'https_poll',
          }),
        ]),
        gossip_events: expect.arrayContaining([
          expect.objectContaining({
            from_witness_id: 'witness-alpha',
            to_witness_id: 'witness-beta',
            source_channel: 'witness_rpc',
          }),
        ]),
      });

      const timeline = await api.request('/v1/transparency-logs/tg-cli-integration-log/timeline');
      expect(timeline.status).toBe(200);
      await expect(timeline.json()).resolves.toMatchObject({
        events: expect.arrayContaining([
          expect.objectContaining({ kind: 'checkpoint' }),
          expect.objectContaining({ kind: 'observation' }),
          expect.objectContaining({ kind: 'gossip' }),
          expect.objectContaining({ kind: 'disagreement' }),
        ]),
      });
    } finally {
      restoreEnvVar('API_ORIGIN', previousEnv.API_ORIGIN);
      restoreEnvVar('REPO_ROOT', previousEnv.REPO_ROOT);
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('can print a smaller human proof report for the transparency sample graph', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'registry-operator-transparency-report-'));
    const previousEnv = {
      API_ORIGIN: process.env.API_ORIGIN,
      REPO_ROOT: process.env.REPO_ROOT,
    };

    try {
      const graphStateFile = path.join(tmp, 'graph', 'registry-state.json');
      const objectsDir = path.join(tmp, 'objects');
      const apiEnv = loadApiEnv({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        AUTH_MODE: 'api_key',
        DATABASE_URL: `file:${path.join(tmp, 'api.db')}`,
        REGISTRY_GRAPH_BACKEND: 'json_file',
        REGISTRY_GRAPH_STATE_FILE: graphStateFile,
        REGISTRY_OBJECTS_DIR: objectsDir,
        TIME_AWARE_GRAPH_BACKEND: 'memory',
        TIME_AWARE_OBJECTS_DIR: path.join(tmp, 'time-aware-objects'),
      });
      const apiDeps = buildApiDependencies(apiEnv);
      await apiDeps.ready();
      const api = buildApiApp(apiDeps);
      const apiServer = await startServer(api.fetch as unknown as FetchHandler);
      const { token: apiToken } = await apiDeps.apiKeys.create({ owner_label: 'Transparency CLI Report' });

      process.env.API_ORIGIN = apiServer.baseUrl;
      process.env.REPO_ROOT = repoRoot;

      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (value?: unknown) => {
        logs.push(String(value));
      };
      try {
        await runCli([
          'seed',
          'transparency-sample',
          '--api-token',
          apiToken,
          '--sample-slug',
          'cli-report',
          '--human-proof-report',
        ]);
      } finally {
        console.log = originalLog;
      }

      const report = JSON.parse(logs.at(-1) ?? '{}') as Record<string, unknown>;
      expect(report).toMatchObject({
        ok: true,
        report_type: 'human-proof-report',
        sample_id: 'cli-report',
        log_id: 'tg-cli-report-log',
        trust_verdict: {
          verification_status: 'consistency_failure',
          checkpoint_signature_valid: true,
          checkpoint_consistency_verified: true,
          witness_quorum_met: true,
          witness_quorum_required: 2,
        },
        network_evidence: {
          checkpoint_history_count: 2,
          observation_count: 3,
          disagreement_count: expect.any(Number),
          gossip_event_count: 1,
          timeline_event_count: expect.any(Number),
        },
      });
      expect(JSON.stringify(report)).toContain('same_size_different_root');
      expect(JSON.stringify(report)).toContain('/v1/transparency-logs/tg-cli-report-log/verification');
      expect(report).not.toHaveProperty('timeline');
      expect(report).not.toHaveProperty('verification');
      expect(report).not.toHaveProperty('log');
    } finally {
      restoreEnvVar('API_ORIGIN', previousEnv.API_ORIGIN);
      restoreEnvVar('REPO_ROOT', previousEnv.REPO_ROOT);
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

type FetchHandler = (request: Request, env?: unknown, executionCtx?: unknown) => Response | Promise<Response>;

async function startServer(fetchHandler: FetchHandler) {
  const port = await getFreePort();
  const server = serve(
    {
      fetch: fetchHandler,
      hostname: '127.0.0.1',
      port,
    },
    () => undefined,
  );
  servers.push(server);
  return {
    baseUrl: `http://127.0.0.1:${port}`,
  };
}

async function getFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Failed to reserve free port.'));
        return;
      }
      const port = address.port;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
    server.on('error', reject);
  });
}

function restoreEnvVar(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
