import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createServer } from 'node:net';
import type { ServerType } from '@hono/node-server';
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import { buildAppDependencies } from '../../src/app/dependencies.js';
import { buildApp } from '../../src/app/server.js';
import { loadEnv } from '../../src/infrastructure/config/env.js';
import {
  agentUrn,
  agentVersionUrn,
  artifactUrn,
  harnessUrn,
  skillUrn,
  skillVersionUrn,
} from '../../../registry/domain/signet/db/graph/freeform/registry/urn.js';

const servers: ServerType[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

describe('MCP transport blackbox e2e', () => {
  it('serves registry discovery/load over the real /mcp transport', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'mcp-transport-'));
    let transport: StreamableHTTPClientTransport | undefined;
    let client: Client | undefined;
    try {
      const env = loadEnv({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        DATABASE_URL: `file:${path.join(tmp, 'mcp.db')}`,
      });
      const deps = buildAppDependencies(env);
      await deps.ready();

      const agent = agentUrn('cursor:mcp-blackbox');
      const agentVersion = agentVersionUrn('cursor:mcp-blackbox', 1);
      const skill = skillUrn('skill:mcp-blackbox');
      const skillVersion = skillVersionUrn('skill:mcp-blackbox', 1);
      const harness = harnessUrn('cursor');
      const artifact = artifactUrn('abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789');

      await deps.registryGraph.upsertNode({
        urn: agent,
        entity_type: 'AGENT',
        properties: {
          agent_key: 'cursor:mcp-blackbox',
          harness_name: 'cursor',
          source_path: 'service/mcp/agent/blackbox/cursor/AGENTS.md',
          active_version_urn: agentVersion,
        },
      });
      await deps.registryGraph.upsertNode({
        urn: skill,
        entity_type: 'SKILL',
        properties: {
          skill_key: 'skill:mcp-blackbox',
          source_path: 'skills/mcp-blackbox.md',
          active_version_urn: skillVersion,
        },
      });
      await deps.registryGraph.upsertNode({
        urn: agentVersion,
        entity_type: 'AGENT_VERSION',
        properties: {
          agent_key: 'cursor:mcp-blackbox',
          version: 1,
          publication_status: 'published',
          active: true,
          publisher: 'test-publisher',
          policy_version: 'registry-policy/v1',
          validation_status: 'passed',
        },
      });
      await deps.registryGraph.upsertNode({
        urn: skillVersion,
        entity_type: 'SKILL_VERSION',
        properties: {
          skill_key: 'skill:mcp-blackbox',
          version: 1,
          lifecycle_status: 'published',
          active: true,
        },
      });
      await deps.registryGraph.upsertNode({
        urn: harness,
        entity_type: 'HARNESS',
        properties: { harness_name: 'cursor' },
      });
      await deps.registryGraph.upsertNode({
        urn: artifact,
        entity_type: 'ARTIFACT',
        properties: { sha256: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789', size_bytes: 10 },
      });
      await deps.registryGraph.upsertEdge({
        from_urn: agent,
        to_urn: skill,
        predicate: 'sg:usesSkill',
        properties: {},
      });
      await deps.registryGraph.upsertEdge({
        from_urn: agent,
        to_urn: harness,
        predicate: 'sg:runsOn',
        properties: {},
      });
      await deps.registryGraph.upsertEdge({
        from_urn: agent,
        to_urn: agentVersion,
        predicate: 'sg:hasVersion',
        properties: {},
      });
      await deps.registryGraph.upsertEdge({
        from_urn: agentVersion,
        to_urn: skill,
        predicate: 'sg:usesSkill',
        properties: {},
      });
      await deps.registryGraph.upsertEdge({
        from_urn: agentVersion,
        to_urn: harness,
        predicate: 'sg:runsOn',
        properties: {},
      });
      await deps.registryGraph.upsertEdge({
        from_urn: skill,
        to_urn: skillVersion,
        predicate: 'sg:hasVersion',
        properties: {},
      });
      await deps.registryGraph.upsertEdge({
        from_urn: skillVersion,
        to_urn: artifact,
        predicate: 'sg:implementedBy',
        properties: {},
      });
      await deps.registryGraph.upsertEdge({
        from_urn: agent,
        to_urn: artifact,
        predicate: 'sg:definedBy',
        properties: {},
      });

      const { token } = await deps.apiKeys.create({ owner_label: 'MCP Reader' });
      const app = buildApp(deps);
      const started = await startServer(app);

      client = new Client({ name: 'mcp-e2e-client', version: '0.1.0' });
      transport = new StreamableHTTPClientTransport(new URL(`${started.baseUrl}/mcp`), {
        requestInit: {
          headers: {
            authorization: `Bearer ${token}`,
            'x-agent-client': 'mcp-e2e',
          },
        },
      });

      await client.connect(transport as unknown as Transport);

      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(['registry.list_agents', 'registry.get_agent', 'registry.get_skill', 'registry.get_artifact']),
      );

      const listResult = await client.callTool({
        name: 'registry.list_agents',
        arguments: {},
      });
      expect(readTextContent(listResult)).not.toContain('MCP error');
      expect(readStructuredContent(listResult)).toMatchObject({
        agents: [
          {
            agent_urn: 'urn:sg:agent:cursor:mcp-blackbox',
            agent_key: 'cursor:mcp-blackbox',
          },
        ],
      });

      const getResult = await client.callTool({
        name: 'registry.get_agent',
        arguments: { agent_urn: 'urn:sg:agent:missing' },
      });
      expect(readIsError(getResult)).toBe(true);
      expect(parseErrorContent(readTextContent(getResult))).toMatchObject({ code: 'REGISTRY_ENTITY_NOT_FOUND' });

      const presentAgent = await client.callTool({
        name: 'registry.get_agent',
        arguments: { agent_urn: 'urn:sg:agent:cursor:mcp-blackbox' },
      });
      expect(readStructuredContent(presentAgent)).toMatchObject({
        active_version: {
          agent_version: {
            urn: 'urn:sg:agent-version:cursor:mcp-blackbox@v1',
          },
        },
      });

      const skillResult = await client.callTool({
        name: 'registry.get_skill',
        arguments: { skill_urn: 'urn:sg:skill:skill:mcp-blackbox' },
      });
      expect(readTextContent(skillResult)).not.toContain('MCP error');
      expect(readStructuredContent(skillResult)).toMatchObject({
        active_version: {
          skill_version: {
            urn: 'urn:sg:skill-version:skill:mcp-blackbox@v1',
          },
        },
        artifacts: [{ artifact_urn: 'urn:sg:artifact:sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789', sha256: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789' }],
      });
    } finally {
      await transport?.close().catch(() => undefined);
      await client?.close().catch(() => undefined);
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

async function startServer(app: ReturnType<typeof buildApp>) {
  const port = await getFreePort();
  const server = serve(
    {
      fetch: app.fetch,
      hostname: '127.0.0.1',
      port,
    },
    () => undefined,
  );
  servers.push(server);
  return {
    server,
    baseUrl: `http://127.0.0.1:${port}`,
  };
}

function readStructuredContent(result: unknown): Record<string, unknown> {
  return ((result as { structuredContent?: Record<string, unknown> }).structuredContent ?? {}) as Record<string, unknown>;
}

function readTextContent(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  const first = content[0];
  return first?.type === 'text' ? (first.text ?? '') : '';
}

function parseErrorContent(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}

function readIsError(result: unknown): boolean {
  return Boolean((result as { isError?: boolean }).isError);
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
