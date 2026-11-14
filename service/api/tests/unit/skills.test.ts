import { describe, expect, it } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';

import { buildAppDependencies } from '../../src/app/dependencies.js';
import { buildApp } from '../../src/app/server.js';
import { loadEnv } from '../../src/infrastructure/config/env.js';

async function buildTestApp(opts?: { registryObjectsDir?: string; graphBackend?: 'memory' | 'json_file' }) {
  const env = loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: ':memory:',
    REGISTRY_GRAPH_BACKEND: opts?.graphBackend ?? 'memory',
    ...(opts?.registryObjectsDir ? { REGISTRY_OBJECTS_DIR: opts.registryObjectsDir } : {}),
  });
  const deps = buildAppDependencies(env);
  await deps.ready();
  const { token } = await deps.apiKeys.create({ owner_label: 'Test Writer' });
  return { app: buildApp(deps), deps, token };
}

describe('skill routes', () => {
  it('GET /v1/skills returns empty list by default', async () => {
    const { app } = await buildTestApp();
    const res = await app.request('/v1/skills');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ skills: [] });
  });

  it('POST /v1/skills creates a skill and GET returns it', async () => {
    const { app, token } = await buildTestApp();
    const create = await app.request('/v1/skills', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        skill_key: 'skill:example-skill',
        display_name: 'Example Skill',
        description: 'A versioned API-created skill.',
      }),
    });

    expect(create.status).toBe(201);
    await expect(create.json()).resolves.toMatchObject({
      skill: {
        urn: 'urn:sg:skill:skill:example-skill',
        properties: {
          skill_key: 'skill:example-skill',
          display_name: 'Example Skill',
        },
      },
      artifacts: [],
    });

    const get = await app.request('/v1/skills/skill:example-skill');
    expect(get.status).toBe(200);
    await expect(get.json()).resolves.toMatchObject({
      skill: {
        urn: 'urn:sg:skill:skill:example-skill',
      },
    });
  });

  it('POST /v1/skills is idempotent for the same payload and 409 for conflicting payloads', async () => {
    const { app, token } = await buildTestApp();

    const first = await app.request('/v1/skills', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        skill_key: 'skill:idempotent',
        display_name: 'Same Skill',
      }),
    });
    expect(first.status).toBe(201);

    const same = await app.request('/v1/skills', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        skill_key: 'skill:idempotent',
        display_name: 'Same Skill',
      }),
    });
    expect(same.status).toBe(200);

    const conflict = await app.request('/v1/skills', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        skill_key: 'skill:idempotent',
        display_name: 'Different Skill',
      }),
    });
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toEqual({
      error: { code: 'SKILL_CREATE_CONFLICT', message: 'Skill already exists with different state.' },
    });
  });

  it('POST /v1/skills writes attached artifact into CAS and links it', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'skills-api-cas-'));
    try {
      const { app, deps, token } = await buildTestApp({ registryObjectsDir: tmp });
      const create = await app.request('/v1/skills', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          skill_key: 'skill:file-backed',
          artifact: {
            content: '# Skill file\n\nhello',
            media_type: 'text/markdown',
            original_path: 'skills/file-backed.md',
          },
        }),
      });

      expect(create.status).toBe(201);
      const created = (await create.json()) as {
        artifacts: Array<{ sha256: string }>;
      };
      const artifact = created.artifacts[0] as { sha256: string };

      const got = await deps.registryCas.getBySha256(artifact.sha256);
      expect(got).not.toBeNull();
      expect(new TextDecoder().decode(got!.bytes)).toBe('# Skill file\n\nhello');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
