import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { buildAppDependencies } from '../../src/app/dependencies.js';
import { buildApp } from '../../src/app/server.js';
import { loadEnv } from '../../src/infrastructure/config/env.js';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function buildTestApp() {
  const objectsDir = await mkdtemp(path.join(os.tmpdir(), 'signet-artifacts-'));
  tempDirs.push(objectsDir);
  const env = loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: ':memory:',
    REGISTRY_GRAPH_BACKEND: 'memory',
    REGISTRY_OBJECTS_DIR: objectsDir,
  });
  const deps = buildAppDependencies(env);
  await deps.ready();
  const { token } = await deps.apiKeys.create({ owner_label: 'Artifact Reader' });
  return { app: buildApp(deps), token, objectsDir };
}

type TestAppLike = {
  request: (input: string, init?: RequestInit) => Response | Promise<Response>;
};

async function publishSkillWithArtifact(
  app: TestAppLike,
  token: string,
  input: { skillKey: string; artifactContent: string; mediaType?: string },
): Promise<string> {
  const auth = { 'content-type': 'application/json', Authorization: `Bearer ${token}` };
  const draft = await app.request(`/v1/skills/${encodeURIComponent(input.skillKey)}/drafts`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      author: 'pablo',
      display_name: 'Artifact endpoint demo',
      artifact: {
        content: input.artifactContent,
        original_path: 'skills/artifact-endpoint.md',
        ...(input.mediaType ? { media_type: input.mediaType } : {}),
      },
    }),
  });
  expect(draft.status).toBe(200);

  const publish = await app.request(`/v1/skills/${encodeURIComponent(input.skillKey)}/versions/1/publish`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ author: 'pablo' }),
  });
  expect(publish.status).toBe(200);

  const version = await app.request(`/v1/skills/${encodeURIComponent(input.skillKey)}/versions/1`);
  expect(version.status).toBe(200);
  const body = (await version.json()) as { artifacts: Array<{ sha256?: string }> };
  const sha256 = body.artifacts[0]?.sha256;
  if (!sha256) {
    throw new Error('Expected the published version to link a content-addressed artifact.');
  }
  return sha256;
}

function expectedContentDigest(sha256: string) {
  return `sha-256=:${Buffer.from(sha256, 'hex').toString('base64')}:`;
}

describe('artifact byte endpoint', () => {
  it('serves content-addressed bytes with digest headers', async () => {
    const { app, token } = await buildTestApp();
    const content = '# Artifact endpoint demo\n';
    const sha256 = await publishSkillWithArtifact(app, token, {
      skillKey: 'skill:artifact-endpoint',
      artifactContent: content,
      mediaType: 'text/markdown',
    });
    expect(sha256).toBe(createHash('sha256').update(content, 'utf8').digest('hex'));

    const response = await app.request(`/v1/artifacts/${sha256}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/markdown');
    expect(response.headers.get('content-digest')).toBe(expectedContentDigest(sha256));
    expect(response.headers.get('x-artifact-digest-verified')).toBe('true');
    await expect(response.text()).resolves.toBe(content);
  });

  it('answers HEAD with the same headers and no body', async () => {
    const { app, token } = await buildTestApp();
    const content = '# Head probe\n';
    const sha256 = await publishSkillWithArtifact(app, token, {
      skillKey: 'skill:artifact-head',
      artifactContent: content,
      mediaType: 'text/markdown',
    });

    const response = await app.request(`/v1/artifacts/${sha256}`, { method: 'HEAD' });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-digest')).toBe(expectedContentDigest(sha256));
    expect(response.headers.get('content-length')).toBe(String(Buffer.byteLength(content, 'utf8')));
    await expect(response.text()).resolves.toBe('');
  });

  it('rejects unknown and malformed digests', async () => {
    const { app } = await buildTestApp();

    const malformed = await app.request('/v1/artifacts/not-a-digest');
    expect(malformed.status).toBe(400);

    const unknown = await app.request(`/v1/artifacts/${'a'.repeat(64)}`);
    expect(unknown.status).toBe(404);
    await expect(unknown.json()).resolves.toMatchObject({ error: { code: 'ARTIFACT_NOT_FOUND' } });
  });

  it('refuses to transport tampered bytes', async () => {
    const { app, token, objectsDir } = await buildTestApp();
    const sha256 = await publishSkillWithArtifact(app, token, {
      skillKey: 'skill:artifact-tamper',
      artifactContent: '# Tamper target\n',
      mediaType: 'text/markdown',
    });

    const objectPath = path.join(objectsDir, sha256.slice(0, 2), sha256);
    await writeFile(objectPath, 'tampered bytes');

    const response = await app.request(`/v1/artifacts/${sha256}`);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'ARTIFACT_DIGEST_MISMATCH' },
    });

    const head = await app.request(`/v1/artifacts/${sha256}`, { method: 'HEAD' });
    expect(head.status).toBe(409);
  });
});
