import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createServer } from 'node:net';
import type { ServerType } from '@hono/node-server';
import { serve } from '@hono/node-server';

import { runCli } from '../src/operator.js';
import { parseLockFile } from '../src/lock.js';
import { loadEnv as loadApiEnv } from '../../../service/api/src/infrastructure/config/env.js';
import { buildAppDependencies as buildApiDependencies } from '../../../service/api/src/app/dependencies.js';
import { buildApp as buildApiApp } from '../../../service/api/src/app/server.js';

// Boots a real API server; on CI runners individual tests take a few seconds
// and trip the 5s vitest default.
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

async function seedSkill(
  baseUrl: string,
  token: string,
  skillKey: string,
  actions: string[],
  governance?: Record<string, unknown>,
) {
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
      ...(action === 'certify' && governance ? { governance } : {}),
    });
    if (res.status !== 200) throw new Error(`${action} on ${skillKey}: ${res.status} ${await res.text()}`);
  }
}

async function publishVersion2(baseUrl: string, token: string, skillKey: string) {
  const draft = await postJson(baseUrl, `/v1/skills/${encodeURIComponent(skillKey)}/drafts`, token, {
    author: 'seed',
    artifact: { content: `# ${skillKey} v2`, original_path: `skills/${skillKey.replaceAll(':', '-')}.md` },
  });
  expect(draft.status).toBe(200);
  // Publish only activates a version when none exists; promoting makes v2
  // the active version so `newer_available` applies to a v1 pin.
  for (const action of ['validate', 'publish', 'promote']) {
    const res = await postJson(baseUrl, `/v1/skills/${encodeURIComponent(skillKey)}/versions/2/${action}`, token, {
      author: 'seed',
    });
    if (res.status !== 200) throw new Error(`v2 ${action}: ${res.status} ${await res.text()}`);
  }
}

function captureJsonLog(spy: ReturnType<typeof vi.spyOn>): unknown {
  const calls = spy.mock.calls;
  const last = calls[calls.length - 1]?.[0];
  return typeof last === 'string' ? JSON.parse(last) : undefined;
}

describe('registry-operator lock + verify lock', () => {
  let tmp = '';
  let baseUrl = '';
  let token = '';
  let lockPath = '';
  let apiDeps: ReturnType<typeof buildApiDependencies>;
  const previousEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'registry-operator-lock-'));
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
    const created = await apiDeps.apiKeys.create({ owner_label: 'Lock Integration' });
    token = created.token;
    lockPath = path.join(tmp, 'signet.lock');

    await seedSkill(baseUrl, token, 'skill:lock-main', ['validate', 'publish']);
    await seedSkill(baseUrl, token, 'skill:lock-revoked', ['validate', 'publish', 'revoke']);
    await seedSkill(baseUrl, token, 'skill:lock-drifted', ['validate', 'publish']);
    await seedSkill(baseUrl, token, 'skill:lock-expired', ['validate', 'publish', 'certify'], {
      certification_expires_at: '2026-01-01T00:00:00.000Z',
    });
  });

  afterAll(async () => {
    restoreEnvVar('API_ORIGIN', previousEnv.API_ORIGIN);
    for (const server of servers.splice(0)) {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
    await rm(tmp, { recursive: true, force: true });
  });

  it('locks published skills and verifies clean pins', async () => {
    await runCli(['lock', '--skill', 'skill:lock-main', '--lock-file', lockPath]);
    const lock = parseLockFile(await readFile(lockPath, 'utf8'));
    expect(lock.entries).toHaveLength(1);
    const pinned = lock.entries[0];
    expect(pinned).toMatchObject({
      type: 'skill',
      key: 'skill:lock-main',
      version: 1,
      publication_urn: 'urn:sg:skill-version:skill:lock-main@v1',
    });
    expect(pinned?.envelope_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(pinned?.artifacts.length).toBeGreaterThan(0);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await runCli(['verify', 'lock', '--lock-file', lockPath]);
      const report = captureJsonLog(logSpy) as {
        verified: boolean;
        failed_count: number;
        entries: Array<{ verdict: string; failures: string[] }>;
      };
      expect(report.verified).toBe(true);
      expect(report.failed_count).toBe(0);
      expect(report.entries[0]?.verdict).toBe('verified');
      expect(report.entries[0]?.failures).toEqual([]);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('updates an existing pin without dropping other entries', async () => {
    await runCli(['lock', '--skill', 'skill:lock-revoked@1', '--lock-file', lockPath]);
    await runCli(['lock', '--skill', 'skill:lock-main@1', '--lock-file', lockPath]);
    const lock = parseLockFile(await readFile(lockPath, 'utf8'));
    expect(lock.entries.map((entry) => entry.key).sort()).toEqual(['skill:lock-main', 'skill:lock-revoked']);
    expect(lock.updated_at >= lock.generated_at).toBe(true);
  });

  it('fails closed on revoked pins', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await expect(runCli(['verify', 'lock', '--lock-file', lockPath])).rejects.toThrow(/Lock verification failed/);
      const report = captureJsonLog(logSpy) as {
        verified: boolean;
        entries: Array<{ key: string; verdict: string; failures: string[]; evidence: Record<string, unknown> }>;
      };
      expect(report.verified).toBe(false);
      const revoked = report.entries.find((entry) => entry.key === 'skill:lock-revoked');
      expect(revoked?.verdict).toBe('failed');
      expect(revoked?.failures).toContain('revoked');
      expect(revoked?.evidence.lifecycle_status).toBe('revoked');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('fails closed on envelope drift', async () => {
    await runCli(['lock', '--skill', 'skill:lock-drifted', '--lock-file', lockPath]);
    // Tamper with the recorded envelope digest, simulating corpus drift.
    const versionUrn = 'urn:sg:skill-version:skill:lock-drifted@v1';
    const node = await apiDeps.graph.getNode(versionUrn);
    expect(node).toBeTruthy();
    await apiDeps.graph.upsertNode({
      urn: versionUrn,
      entity_type: 'SKILL_VERSION',
      properties: { ...node?.properties, canonical_json_sha256: 'f'.repeat(64) },
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await expect(runCli(['verify', 'lock', '--lock-file', lockPath])).rejects.toThrow(/Lock verification failed/);
      const report = captureJsonLog(logSpy) as {
        entries: Array<{ key: string; verdict: string; failures: string[] }>;
      };
      const drifted = report.entries.find((entry) => entry.key === 'skill:lock-drifted');
      expect(drifted?.verdict).toBe('failed');
      expect(drifted?.failures).toContain('envelope_sha256_drift');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('fails closed on expired certifications', async () => {
    await runCli(['lock', '--skill', 'skill:lock-expired', '--lock-file', lockPath]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await expect(runCli(['verify', 'lock', '--lock-file', lockPath])).rejects.toThrow(/Lock verification failed/);
      const report = captureJsonLog(logSpy) as {
        entries: Array<{ key: string; verdict: string; failures: string[] }>;
      };
      const expired = report.entries.find((entry) => entry.key === 'skill:lock-expired');
      expect(expired?.verdict).toBe('failed');
      expect(expired?.failures).toContain('certification_expired');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('warns about newer available versions without failing, and --strict escalates', async () => {
    // skill:lock-main is pinned at v1; publishing v2 makes a newer version active.
    await publishVersion2(baseUrl, token, 'skill:lock-main');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      // Reset the lock so only the main skill is pinned, then verify.
      await runCli(['lock', '--skill', 'skill:lock-main@1', '--lock-file', lockPath]);
      // Every other pinned skill in the file would fail; write a dedicated file.
      const lonePath = path.join(tmp, 'lone-signet.lock');
      await runCli(['lock', '--skill', 'skill:lock-main@1', '--lock-file', lonePath]);
      await runCli(['verify', 'lock', '--lock-file', lonePath]);
      const report = captureJsonLog(logSpy) as {
        verified: boolean;
        entries: Array<{ verdict: string; warnings: string[]; evidence: Record<string, unknown> }>;
      };
      expect(report.verified).toBe(true);
      expect(report.entries[0]?.verdict).toBe('verified');
      expect(report.entries[0]?.warnings).toContain('newer_available');
      expect(report.entries[0]?.evidence.active_version).toBe(2);

      await expect(runCli(['verify', 'lock', '--lock-file', lonePath, '--strict'])).rejects.toThrow(
        /Lock verification failed/,
      );
    } finally {
      logSpy.mockRestore();
    }
  });

  it('reports a missing lock file instead of guessing', async () => {
    await expect(
      runCli(['verify', 'lock', '--lock-file', path.join(tmp, 'missing-signet.lock')]),
    ).rejects.toThrow(/Lock file not found/);
  });
});
