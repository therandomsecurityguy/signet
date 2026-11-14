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

const servers: ServerType[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

describe('API blackbox e2e', () => {
  it('preserves skills and agents across real HTTP server restarts with json_file backend', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'api-blackbox-'));
    const graphStateFile = path.join(tmp, 'graph', 'state.json');
    const objectsDir = path.join(tmp, 'objects');

    try {
      const first = await startServer({
        REGISTRY_GRAPH_BACKEND: 'json_file',
        REGISTRY_GRAPH_STATE_FILE: graphStateFile,
        REGISTRY_OBJECTS_DIR: objectsDir,
        DATABASE_URL: path.join(tmp, 'api.db'),
      });

      const createSkill = await fetch(`${first.baseUrl}/v1/skills`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${first.token}` },
        body: JSON.stringify({
          skill_key: 'skill:blackbox',
          display_name: 'Blackbox Skill',
        }),
      });
      expect(createSkill.status).toBe(201);

      const createAgent = await fetch(`${first.baseUrl}/v1/agents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${first.token}` },
        body: JSON.stringify({
          agent_key: 'cursor:blackbox',
          display_name: 'Blackbox Agent',
          skill_refs: [{ skill_key: 'skill:blackbox' }],
          artifact: {
            content: '# Agent file\n\nfrom blackbox test',
            original_path: 'agent/blackbox/AGENTS.md',
          },
        }),
      });
      expect(createAgent.status).toBe(201);

      await stopServer(first.server);

      const second = await startServer({
        REGISTRY_GRAPH_BACKEND: 'json_file',
        REGISTRY_GRAPH_STATE_FILE: graphStateFile,
        REGISTRY_OBJECTS_DIR: objectsDir,
        DATABASE_URL: path.join(tmp, 'api.db'),
      });

      const getAgent = await fetch(`${second.baseUrl}/v1/agents/cursor:blackbox`);
      expect(getAgent.status).toBe(200);
      await expect(getAgent.json()).resolves.toMatchObject({
        agent: {
          urn: 'urn:tg:agent:cursor:blackbox',
        },
        skills: [
          {
            skill_urn: 'urn:tg:skill:skill:blackbox',
          },
        ],
        artifacts: [
          {
            sha256: expect.any(String),
          },
        ],
      });

      const sameCreate = await fetch(`${second.baseUrl}/v1/agents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${second.token}` },
        body: JSON.stringify({
          agent_key: 'cursor:blackbox',
          display_name: 'Blackbox Agent',
          skill_refs: [{ skill_key: 'skill:blackbox' }],
          artifact: {
            content: '# Agent file\n\nfrom blackbox test',
            original_path: 'agent/blackbox/AGENTS.md',
          },
        }),
      });
      expect(sameCreate.status).toBe(200);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

async function startServer(overrides: Record<string, string>) {
  const port = await getFreePort();
  const env = loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    HOST: '127.0.0.1',
    PORT: String(port),
    ...overrides,
  });
  const deps = buildAppDependencies(env);
  await deps.ready();
  const { token } = await deps.apiKeys.create({ owner_label: 'Blackbox Writer' });
  const app = buildApp(deps);

  const started = await new Promise<{ server: ServerType; port: number }>((resolve) => {
    const server = serve(
      {
        fetch: app.fetch,
        hostname: env.HOST,
        port: env.PORT,
      },
      (info) => {
        resolve({ server, port: info.port });
      },
    );
  });

  servers.push(started.server);
  return {
    server: started.server,
    baseUrl: `http://127.0.0.1:${started.port}`,
    token,
  };
}

async function stopServer(server: ServerType) {
  const idx = servers.indexOf(server);
  if (idx >= 0) servers.splice(idx, 1);

  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
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
