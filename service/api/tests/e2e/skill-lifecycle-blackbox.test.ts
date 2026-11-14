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

describe('skill lifecycle blackbox e2e', () => {
  it('drives the lifecycle flow over real HTTP', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'skill-lifecycle-blackbox-'));
    try {
      const started = await startServer({
        REGISTRY_GRAPH_BACKEND: 'json_file',
        REGISTRY_GRAPH_STATE_FILE: path.join(tmp, 'graph', 'state.json'),
        REGISTRY_OBJECTS_DIR: path.join(tmp, 'objects'),
        DATABASE_URL: path.join(tmp, 'api.db'),
      });

      const draft = await fetch(`${started.baseUrl}/v1/skills/skill:lifecycle-bb/drafts`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${started.token}`,
        },
        body: JSON.stringify({
          author: 'pablo',
          commit_sha: 'abc123',
          git_tag: 'v0.1.0',
          artifact_signature: 'sig-1',
          artifact: {
            content: '# lifecycle blackbox',
            original_path: 'skills/lifecycle-bb.md',
          },
        }),
      });
      expect(draft.status).toBe(200);

      const validate = await fetch(`${started.baseUrl}/v1/skills/skill:lifecycle-bb/versions/1/validate`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${started.token}`,
        },
        body: JSON.stringify({ author: 'pablo' }),
      });
      expect(validate.status).toBe(200);

      const publish = await fetch(`${started.baseUrl}/v1/skills/skill:lifecycle-bb/versions/1/publish`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${started.token}`,
        },
        body: JSON.stringify({ author: 'pablo' }),
      });
      expect(publish.status).toBe(200);

      const certify = await fetch(`${started.baseUrl}/v1/skills/skill:lifecycle-bb/versions/1/certify`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${started.token}`,
        },
        body: JSON.stringify({ author: 'principal', note: 'approved' }),
      });
      expect(certify.status).toBe(200);

      const active = await fetch(`${started.baseUrl}/v1/skills/skill:lifecycle-bb/active`);
      expect(active.status).toBe(200);
      await expect(active.json()).resolves.toMatchObject({
        skill_version: {
          properties: {
            version: 1,
            lifecycle_status: 'certified',
            certified: true,
            certified_by: 'principal',
            active: true,
          },
        },
      });
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
  const { token } = await deps.apiKeys.create({ owner_label: 'Lifecycle Blackbox Writer' });
  const app = buildApp(deps);

  const started = await new Promise<{ server: ServerType; port: number }>((resolve) => {
    const server = serve(
      {
        fetch: app.fetch,
        hostname: env.HOST,
        port: env.PORT,
      },
      (info) => resolve({ server, port: info.port }),
    );
  });

  servers.push(started.server);
  return {
    server: started.server,
    baseUrl: `http://127.0.0.1:${started.port}`,
    token,
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
