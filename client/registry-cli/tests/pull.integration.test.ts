import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createServer } from 'node:net';
import type { ServerType } from '@hono/node-server';
import { serve } from '@hono/node-server';

import { runCli } from '../src/operator.js';
import { targetDirectory } from '../src/pull.js';
import { loadEnv as loadApiEnv } from '../../../service/api/src/infrastructure/config/env.js';
import { buildAppDependencies as buildApiDependencies } from '../../../service/api/src/app/dependencies.js';
import { buildApp as buildApiApp } from '../../../service/api/src/app/server.js';

// Boots a real API server; on CI runners individual tests take a few seconds.
vi.setConfig({ testTimeout: 30_000 });

const servers: ServerType[] = [];

type FetchHandler = (request: Request, env?: unknown, executionCtx?: unknown) => Response | Promise<Response>;

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
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
    server.on('error', reject);
  });
}

async function startServer(fetchHandler: FetchHandler) {
  const port = await getFreePort();
  const server = serve({ fetch: fetchHandler, hostname: '127.0.0.1', port }, () => undefined);
  servers.push(server);
  return `http://127.0.0.1:${port}`;
}

function restoreEnvVar(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function postJson(baseUrl: string, apiPath: string, token: string, body: unknown): Promise<Response> {
  return await fetch(`${baseUrl}${apiPath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

async function seedSkill(baseUrl: string, token: string, skillKey: string, actions: string[]) {
  const create = await postJson(baseUrl, '/v1/skills', token, {
    skill_key: skillKey,
    artifact: { content: `# ${skillKey}` },
  });
  expect(create.status).toBe(201);
  const draft = await postJson(baseUrl, `/v1/skills/${encodeURIComponent(skillKey)}/drafts`, token, {
    author: 'seed',
    artifact: { content: `# ${skillKey} v1`, original_path: `skills/${skillKey.replaceAll(':', '-')}.md` },
  });
  expect(draft.status).toBe(200);
  for (const action of actions) {
    const res = await postJson(baseUrl, `/v1/skills/${encodeURIComponent(skillKey)}/versions/1/${action}`, token, {
      author: 'seed',
    });
    if (res.status !== 200) throw new Error(`${action} on ${skillKey}: ${res.status} ${await res.text()}`);
  }
}

describe('registry-operator pull', () => {
  let tmp = '';
  let baseUrl = '';
  let token = '';
  let outDir = '';
  let apiDeps: ReturnType<typeof buildApiDependencies>;
  const previousEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'registry-operator-pull-'));
    previousEnv.API_ORIGIN = process.env.API_ORIGIN;
    const apiEnv = loadApiEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      AUTH_MODE: 'api_key',
      DATABASE_URL: `file:${path.join(tmp, 'api.db')}`,
      REGISTRY_GRAPH_BACKEND: 'json_file',
      REGISTRY_GRAPH_STATE_FILE: path.join(tmp, 'graph', 'registry-state.json'),
      REGISTRY_OBJECTS_DIR: path.join(tmp, 'objects'),
      TIME_AWARE_GRAPH_BACKEND: 'memory',
      TIME_AWARE_OBJECTS_DIR: path.join(tmp, 'time-aware-objects'),
    });
    apiDeps = buildApiDependencies(apiEnv);
    await apiDeps.ready();
    baseUrl = await startServer(buildApiApp(apiDeps).fetch as unknown as FetchHandler);
    process.env.API_ORIGIN = baseUrl;
    const created = await apiDeps.apiKeys.create({ owner_label: 'Pull Integration' });
    token = created.token;
    outDir = path.join(tmp, 'materialized');

    await seedSkill(baseUrl, token, 'skill:pull-me', ['validate', 'publish']);
    await seedSkill(baseUrl, token, 'skill:pull-revoked', ['validate', 'publish', 'revoke']);
    await seedSkill(baseUrl, token, 'skill:pull-drifted', ['validate', 'publish']);
  });

  afterAll(async () => {
    restoreEnvVar('API_ORIGIN', previousEnv.API_ORIGIN);
    for (const server of servers.splice(0)) {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
    await rm(tmp, { recursive: true, force: true });
  });

  it('pulls verified bytes with an integrity manifest', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await runCli(['pull', 'skill:pull-me', '--out', outDir]);
      const summary = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])) as {
        pulled: Array<{ key: string; version: number; directory: string; valid_signatures: number }>;
      };
      expect(summary.pulled[0]?.key).toBe('skill:pull-me');
      expect(summary.pulled[0]?.version).toBe(1);
    } finally {
      logSpy.mockRestore();
    }

    const pullDir = targetDirectory(outDir, 'skill', 'skill:pull-me', 1);
    const manifestRaw = await readFile(path.join(pullDir, 'manifest.json'), 'utf8');
    const manifest = JSON.parse(manifestRaw) as {
      manifest_version: number;
      key: string;
      version: number;
      publication_urn: string;
      envelope_sha256: string;
      artifacts: Array<{ sha256: string; file: string; media_type?: string }>;
      valid_signatures: number;
    };
    expect(manifest).toMatchObject({
      manifest_version: 1,
      key: 'skill:pull-me',
      version: 1,
      publication_urn: 'urn:sg:skill-version:skill:pull-me@v1',
    });
    expect(manifest.envelope_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.valid_signatures).toBe(0);
    // The file keeps its source basename (portable, human-friendly).
    expect(manifest.artifacts[0]?.file).toBe('skill-pull-me.md');

    const content = await readFile(path.join(pullDir, manifest.artifacts[0]?.file ?? 'missing'), 'utf8');
    expect(content).toBe('# skill:pull-me v1');

    // The written artifact matches the manifest digest, and the envelope
    // bytes match the recorded envelope digest.
    const artifactBytes = await readFile(path.join(pullDir, manifest.artifacts[0]?.file ?? 'missing'));
    expect(createHash('sha256').update(artifactBytes).digest('hex')).toBe(manifest.artifacts[0]?.sha256);
    const envelopeBytes = await readFile(path.join(pullDir, 'envelope.json'));
    expect(createHash('sha256').update(envelopeBytes).digest('hex')).toBe(manifest.envelope_sha256);

    // The registry agrees about the artifact digest.
    const versionRes = await fetch(`${baseUrl}/v1/skills/skill%3Apull-me/versions/1`);
    const version = (await versionRes.json()) as { artifacts: Array<{ sha256?: string }> };
    expect(manifest.artifacts[0]?.sha256).toBe(version.artifacts[0]?.sha256);
  });

  it('accepts pinned versions and refreshes idempotently', async () => {
    await runCli(['pull', 'skill:pull-me@1', '--out', outDir]);
    const pullDir = targetDirectory(outDir, 'skill', 'skill:pull-me', 1);
    expect((await stat(path.join(pullDir, 'manifest.json'))).isFile()).toBe(true);
  });

  it('fails closed for unsigned packs under --strict', async () => {
    await expect(
      runCli(['pull', 'skill:pull-me', '--out', outDir, '--strict']),
    ).rejects.toThrow(/strict verification/);
  });

  it('refuses revoked versions', async () => {
    await expect(runCli(['pull', 'skill:pull-revoked@1', '--out', outDir])).rejects.toThrow(/revoked/);
  });

  it('refuses envelope drift', async () => {
    const versionUrn = 'urn:sg:skill-version:skill:pull-drifted@v1';
    const node = await apiDeps.graph.getNode(versionUrn);
    expect(node).toBeTruthy();
    await apiDeps.graph.upsertNode({
      urn: versionUrn,
      entity_type: 'SKILL_VERSION',
      properties: {
        ...node?.properties,
        // Tamper both the publish-time digest and the frozen-envelope anchor.
        canonical_json_sha256: 'f'.repeat(64),
        publication_envelope_sha256: 'f'.repeat(64),
      },
    });
    await expect(runCli(['pull', 'skill:pull-drifted', '--out', outDir])).rejects.toThrow(/digest/);
  });

  it('requires an output directory', async () => {
    await expect(runCli(['pull', 'skill:pull-me'])).rejects.toThrow(/Usage: registry-operator pull/);
  });
});
