import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createServer } from 'node:net';
import type { ServerType } from '@hono/node-server';
import { serve } from '@hono/node-server';

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

describe('MCP registry blackbox e2e', () => {
  it('serves registry tools over real HTTP using seeded registry state', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'mcp-blackbox-'));
    try {
      const env = loadEnv({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        DATABASE_URL: `file:${path.join(tmp, 'mcp.db')}`,
      });
      const deps = buildAppDependencies(env);
      await deps.ready();

      const agent = agentUrn('cursor:blackbox');
      const agentVersion = agentVersionUrn('cursor:blackbox', 1);
      const skill = skillUrn('skill:blackbox');
      const skillVersion = skillVersionUrn('skill:blackbox', 1);
      const harness = harnessUrn('cursor');
      const artifact = artifactUrn('abc123');

      await deps.registryGraph.upsertNode({
        urn: agent,
        entity_type: 'AGENT',
        properties: {
          agent_key: 'cursor:blackbox',
          harness_name: 'cursor',
          source_path: 'service/mcp/agent/blackbox/cursor/AGENTS.md',
          active_version_urn: agentVersion,
        },
      });
      await deps.registryGraph.upsertNode({
        urn: skill,
        entity_type: 'SKILL',
        properties: {
          skill_key: 'skill:blackbox',
          source_path: 'skills/blackbox.md',
          active_version_urn: skillVersion,
        },
      });
      await deps.registryGraph.upsertNode({
        urn: agentVersion,
        entity_type: 'AGENT_VERSION',
        properties: {
          agent_key: 'cursor:blackbox',
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
          skill_key: 'skill:blackbox',
          version: 1,
          lifecycle_status: 'published',
          active: true,
          publisher: 'test-publisher',
          policy_version: 'registry-policy/v1',
          validation_status: 'passed',
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
        properties: { sha256: 'abc123', size_bytes: 10 },
      });
      await deps.registryGraph.upsertEdge({
        from_urn: agent,
        to_urn: skill,
        predicate: 'sg:usesSkill',
        properties: {},
      });
      await deps.registryGraph.upsertEdge({
        from_urn: agent,
        to_urn: agentVersion,
        predicate: 'sg:hasVersion',
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
        to_urn: artifact,
        predicate: 'sg:definedBy',
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
        from_urn: agentVersion,
        to_urn: artifact,
        predicate: 'sg:definedBy',
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

      const { token } = await deps.apiKeys.create({ owner_label: 'Blackbox Reader' });
      const app = buildApp(deps);
      const started = await startServer(app);

      const list = await fetch(`${started.baseUrl}/v1/tools/registry.list_agents:execute`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          'x-agent-client': 'e2e',
        },
        body: JSON.stringify({}),
      });
      expect(list.status).toBe(200);
      await expect(list.json()).resolves.toMatchObject({
        error: null,
        result: {
          agents: [
            {
              agent_urn: 'urn:sg:agent:cursor:blackbox',
              agent_key: 'cursor:blackbox',
            },
          ],
        },
      });

      const get = await fetch(`${started.baseUrl}/v1/tools/registry.get_agent:execute`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          'x-agent-client': 'e2e',
        },
        body: JSON.stringify({ agent_urn: 'urn:sg:agent:cursor:blackbox' }),
      });
      expect(get.status).toBe(200);
      await expect(get.json()).resolves.toMatchObject({
        error: null,
        result: {
          agent: {
            urn: 'urn:sg:agent:cursor:blackbox',
          },
          active_version: {
            agent_version: {
              urn: 'urn:sg:agent-version:cursor:blackbox@v1',
            },
          },
          skills: [{ skill_urn: 'urn:sg:skill:skill:blackbox' }],
          harnesses: [{ harness_urn: 'urn:sg:harness:cursor' }],
          artifacts: [{ artifact_urn: 'urn:sg:artifact:sha256:abc123' }],
        },
      });

      const verify = await fetch(`${started.baseUrl}/v1/tools/registry.verify_publication:execute`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          'x-agent-client': 'e2e',
        },
        body: JSON.stringify({ version_urn: 'urn:sg:skill-version:skill:blackbox@v1' }),
      });
      expect(verify.status).toBe(200);
      await expect(verify.json()).resolves.toMatchObject({
        error: null,
        result: {
          publication_urn: 'urn:sg:skill-version:skill:blackbox@v1',
          logical_urn: 'urn:sg:skill:skill:blackbox',
          entity_type: 'SKILL_VERSION',
          verification_status: 'verified',
          publication_envelope_artifact_present: false,
          publication_envelope_artifact_sha256_matches: null,
          live_envelope_matches_frozen_artifact: null,
        },
      });

      const verifyMissing = await fetch(`${started.baseUrl}/v1/tools/registry.verify_publication:execute`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          'x-agent-client': 'e2e',
        },
        body: JSON.stringify({ version_urn: 'urn:sg:skill-version:skill:missing@v1' }),
      });
      expect(verifyMissing.status).toBe(200);
      await expect(verifyMissing.json()).resolves.toMatchObject({
        result: null,
        error: { code: 'REGISTRY_ENTITY_NOT_FOUND' },
      });

      const attestations = await fetch(
        `${started.baseUrl}/v1/tools/registry.get_attestations:execute`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
            'x-agent-client': 'e2e',
          },
          body: JSON.stringify({ version_urn: 'urn:sg:skill-version:skill:blackbox@v1' }),
        },
      );
      expect(attestations.status).toBe(200);
      await expect(attestations.json()).resolves.toMatchObject({
        error: null,
        result: { attestations: [] },
      });
    } finally {
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
