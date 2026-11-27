import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createServer } from 'node:net';
import type { ServerType } from '@hono/node-server';
import { serve } from '@hono/node-server';

import { buildAppDependencies, type AppDependencies } from '../../src/app/dependencies.js';
import { buildApp } from '../../src/app/server.js';
import { loadEnv } from '../../src/infrastructure/config/env.js';
import {
  artifactUrn,
  skillUrn,
  skillVersionUrn,
} from '../../../registry/domain/signet/db/graph/freeform/registry/urn.js';

vi.setConfig({ testTimeout: 15_000 });

const servers: ServerType[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

async function seedSkillWithBody(
  deps: AppDependencies,
  skillKey: string,
  opts: { revoked?: boolean; body: string } = { body: '' },
) {
  const graph = deps.registryGraph;
  const versionUrn = skillVersionUrn(skillKey, 1);
  await graph.upsertNode({
    urn: skillUrn(skillKey),
    entity_type: 'SKILL',
    properties: { skill_key: skillKey, active_version_urn: versionUrn },
  });
  await graph.upsertNode({
    urn: versionUrn,
    entity_type: 'SKILL_VERSION',
    properties: {
      skill_key: skillKey,
      version: 1,
      lifecycle_status: opts.revoked ? 'revoked' : 'published',
      ...(opts.revoked ? { revoked: true, publication_status: 'revoked' } : { active: true }),
      publisher: 'resources-e2e',
      policy_version: 'registry-policy/v1',
      validation_status: 'passed',
    },
  });
  const artifact = await deps.registryCas.put({
    bytes: Buffer.from(opts.body, 'utf8'),
    media_type: 'text/markdown',
  });
  await graph.upsertNode({
    urn: artifactUrn(artifact.sha256),
    entity_type: 'ARTIFACT',
    properties: { sha256: artifact.sha256, size_bytes: artifact.size_bytes, media_type: artifact.media_type },
  });
  await graph.upsertEdge({
    from_urn: versionUrn,
    to_urn: artifactUrn(artifact.sha256),
    predicate: 'sg:implementedBy',
    properties: {},
  });
}

async function startServer(app: ReturnType<typeof buildApp>) {
  const port = await getFreePort();
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port }, () => undefined);
  servers.push(server);
  return `http://127.0.0.1:${port}`;
}

async function getFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Failed to allocate a port.'));
        return;
      }
      const port = address.port;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
    server.on('error', reject);
  });
}

async function buildSeededApp() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'mcp-resources-'));
  const env = loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: `file:${path.join(tmp, 'mcp.db')}`,
    REGISTRY_GRAPH_BACKEND: 'memory',
    REGISTRY_OBJECTS_DIR: path.join(tmp, 'objects'),
  });
  const deps = buildAppDependencies(env);
  await deps.ready();
  await seedSkillWithBody(deps, 'skill:resource-clean', { body: 'verified publication bytes' });
  await seedSkillWithBody(deps, 'skill:resource-revoked', { revoked: true, body: 'revoked bytes' });
  const { token } = await deps.apiKeys.create({ owner_label: 'Resources E2E' });
  const baseUrl = await startServer(buildApp(deps));
  return { baseUrl, token, tmp };
}

type RpcResponse = {
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
};

async function rpc(baseUrl: string, token: string, method: string, params?: unknown): Promise<RpcResponse> {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
      'x-agent-client': 'resources-e2e',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params !== undefined ? { params } : {}) }),
  });
  const text = await response.text();
  if ((response.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const dataLine = text.split('\n').find((line) => line.startsWith('data: '));
    if (!dataLine) throw new Error(`No SSE data line in response: ${text.slice(0, 200)}`);
    return JSON.parse(dataLine.slice('data: '.length)) as RpcResponse;
  }
  return JSON.parse(text) as RpcResponse;
}

describe('MCP registry resources', () => {
  it('lists templates and the index, and reads a skill body through the verified path', async () => {
    const { baseUrl, token, tmp } = await buildSeededApp();
    try {
      const templates = await rpc(baseUrl, token, 'resources/templates/list');
      const templateUris = (
        (templates.result?.['resourceTemplates'] ?? []) as Array<{ uriTemplate: string }>
      ).map((template) => template.uriTemplate);
      expect(templateUris).toContain('signet://skill/{skill_key}');
      expect(templateUris).toContain('signet://agent/{agent_key}');

      const listed = await rpc(baseUrl, token, 'resources/list');
      const resourceUris = ((listed.result?.['resources'] ?? []) as Array<{ uri: string }>).map(
        (resource) => resource.uri,
      );
      expect(resourceUris).toContain('signet://index');

      const index = await rpc(baseUrl, token, 'resources/read', { uri: 'signet://index' });
      const indexText = ((index.result?.['contents'] ?? []) as Array<{ text: string }>)[0]?.text ?? '';
      const indexPayload = JSON.parse(indexText) as { skills: Array<{ key: string; uri: string }> };
      const clean = indexPayload.skills.find((skill) => skill.key === 'skill:resource-clean');
      expect(clean?.uri).toBe('signet://skill/skill%3Aresource-clean');

      const body = await rpc(baseUrl, token, 'resources/read', { uri: 'signet://skill/skill:resource-clean' });
      const content = ((body.result?.['contents'] ?? []) as Array<{ uri: string; mimeType: string; text: string }>)[0];
      expect(content?.text).toBe('verified publication bytes');
      expect(content?.mimeType).toBe('text/markdown');
      expect(content?.uri).toBe('signet://skill/skill:resource-clean');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('fails closed for revoked publications and unknown keys', async () => {
    const { baseUrl, token, tmp } = await buildSeededApp();
    try {
      const revoked = await rpc(baseUrl, token, 'resources/read', { uri: 'signet://skill/skill:resource-revoked' });
      expect(revoked.result).toBeUndefined();
      expect(revoked.error?.message ?? '').toMatch(/REVOKED/i);

      const unknown = await rpc(baseUrl, token, 'resources/read', { uri: 'signet://skill/skill:no-such' });
      expect(unknown.result).toBeUndefined();
      expect(unknown.error?.message ?? '').toMatch(/NOT_FOUND/i);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
