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

describe('time-aware blackbox e2e', () => {
  it('creates a draft workspace and resolves time-aware navigation over real HTTP', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'time-aware-blackbox-'));
    try {
      const env = loadEnv({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        HOST: '127.0.0.1',
        PORT: String(await getFreePort()),
        DATABASE_URL: `file:${path.join(tmp, 'api.db')}`,
        REGISTRY_GRAPH_BACKEND: 'memory',
        TIME_AWARE_GRAPH_BACKEND: 'json_file',
        TIME_AWARE_GRAPH_STATE_FILE: path.join(tmp, 'graph', 'time-aware-state.json'),
        TIME_AWARE_OBJECTS_DIR: path.join(tmp, 'objects'),
      });

      const deps = buildAppDependencies(env);
      await deps.ready();
      const { token } = await deps.apiKeys.create({ owner_label: 'Time Blackbox Writer' });
      const manifestParent = await deps.timeAwareCore.createArtifactManifest({
        manifest_id: 'manifest-1',
        author: 'pablo',
        artifact_blobs: [{ content: 'hello', encoding: 'utf8' }],
      });
      const manifestCommit = await deps.timeAwareCore.createArtifactManifest({
        manifest_id: 'manifest-2',
        author: 'pablo',
        artifact_blobs: [{ content: 'world', encoding: 'utf8' }],
      });
      await deps.timeAwareCore.createArtifactManifest({
        manifest_id: 'manifest-3',
        author: 'pablo',
        artifact_blobs: [{ content: 'orphan', encoding: 'utf8' }],
      });
      await deps.timeAwareCore.createCommit({
        commit_id: 'c0',
        author: 'pablo',
        message: 'parent commit',
        manifest_urns: [manifestParent.value.urn],
        transaction_time: '2026-03-01T00:00:00Z',
        valid_from: '2026-03-01T00:00:00Z',
        valid_to: '2026-03-05T00:00:00Z',
      });
      await deps.timeAwareCore.createCommit({
        commit_id: 'c1',
        author: 'pablo',
        message: 'seed commit',
        parent_commit_urns: ['urn:sg:commit:c0'],
        manifest_urns: [manifestCommit.value.urn],
        transaction_time: '2026-03-05T00:00:00Z',
        valid_from: '2026-03-05T00:00:00Z',
      });
      await deps.timeAwareCore.createRef({
        ref_name: 'main',
        commit_urn: 'urn:sg:commit:c1',
        author: 'pablo',
      });
      await deps.timeAwareCore.createTag({
        tag_name: 'release-1',
        commit_urn: 'urn:sg:commit:c1',
        author: 'pablo',
      });
      await deps.timeAwareCore.createRetentionRoot({
        root_id: 'root-1',
        root_kind: 'release',
        commit_urns: ['urn:sg:commit:c1'],
      });
      await deps.timeAwareCore.createRetentionRoot({
        root_id: 'root-2',
        root_kind: 'secondary',
        commit_urns: ['urn:sg:commit:c0'],
      });

      const app = buildApp(deps);
      const server = serve(
        {
          fetch: app.fetch,
          hostname: env.HOST,
          port: env.PORT,
        },
        () => undefined,
      );
      servers.push(server);
      const baseUrl = `http://127.0.0.1:${env.PORT}`;

      const create = await fetch(`${baseUrl}/v1/time-aware/refs/main/workspaces/ws-alpha/draft`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          owner: 'alpha',
          expires_at: '2026-12-31T00:00:00Z',
        }),
      });

      expect(create.status).toBe(201);
      await expect(create.json()).resolves.toMatchObject({
        workspace: {
          urn: 'urn:sg:workspace:ws-alpha',
        },
      });

      const list = await fetch(`${baseUrl}/v1/time-aware/workspaces`);
      expect(list.status).toBe(200);
      await expect(list.json()).resolves.toMatchObject({
        workspaces: [
          {
            urn: 'urn:sg:workspace:ws-alpha',
          },
        ],
      });

      const commitDetails = await fetch(`${baseUrl}/v1/time-aware/commits/c1`);
      expect(commitDetails.status).toBe(200);
      await expect(commitDetails.json()).resolves.toMatchObject({
        commit: { urn: 'urn:sg:commit:c1' },
        parent_commits: [{ urn: 'urn:sg:commit:c0' }],
        manifests: [{ urn: 'urn:sg:artifact-manifest:manifest-2' }],
        blobs: [{ urn: 'urn:sg:artifact-blob:sha256:486ea46224d1bb4fb680f34f7c9ad96a8f24ec88be73ea8e5a6c65260e9cb8a7' }],
        refs: [{ urn: 'urn:sg:ref:main' }],
        tags: [{ urn: 'urn:sg:tag:release-1' }],
        workspaces: [{ urn: 'urn:sg:workspace:ws-alpha' }],
      });

      const filteredRefs = await fetch(`${baseUrl}/v1/time-aware/refs?commit_urn=urn:sg:commit:c1`);
      expect(filteredRefs.status).toBe(200);
      await expect(filteredRefs.json()).resolves.toMatchObject({
        refs: [{ urn: 'urn:sg:ref:main' }],
      });

      const temporalCommits = await fetch(
        `${baseUrl}/v1/time-aware/commits?valid_at=2026-03-03T00:00:00Z&transaction_as_of=2026-03-10T00:00:00Z`,
      );
      expect(temporalCommits.status).toBe(200);
      await expect(temporalCommits.json()).resolves.toMatchObject({
        commits: [{ urn: 'urn:sg:commit:c0' }],
      });

      const temporalCommitDetails = await fetch(
        `${baseUrl}/v1/time-aware/commits/c1?transaction_as_of=2026-03-04T00:00:00Z`,
      );
      expect(temporalCommitDetails.status).toBe(404);

      const invalidTemporalRefs = await fetch(`${baseUrl}/v1/time-aware/refs?valid_at=not-a-date`);
      expect(invalidTemporalRefs.status).toBe(400);

      const analysis = await fetch(`${baseUrl}/v1/time-aware/retention-roots/root-1/analysis`);
      expect(analysis.status).toBe(200);
      await expect(analysis.json()).resolves.toMatchObject({
        retention_root: { urn: 'urn:sg:retention-root:root-1' },
        direct_commits: [{ urn: 'urn:sg:commit:c1' }],
        reachable_commits: [{ urn: 'urn:sg:commit:c0' }, { urn: 'urn:sg:commit:c1' }],
        reachable_manifests: [
          { urn: 'urn:sg:artifact-manifest:manifest-1' },
          { urn: 'urn:sg:artifact-manifest:manifest-2' },
        ],
        direct_blobs: [],
        reachable_blobs: [
          { urn: 'urn:sg:artifact-blob:sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824' },
          { urn: 'urn:sg:artifact-blob:sha256:486ea46224d1bb4fb680f34f7c9ad96a8f24ec88be73ea8e5a6c65260e9cb8a7' },
        ],
        refs: [{ urn: 'urn:sg:ref:main' }],
        tags: [{ urn: 'urn:sg:tag:release-1' }],
        workspaces: [{ urn: 'urn:sg:workspace:ws-alpha' }],
      });

      const temporalAnalysis = await fetch(
        `${baseUrl}/v1/time-aware/retention-roots/root-1/analysis?valid_at=2026-03-03T00:00:00Z&transaction_as_of=2026-03-03T00:00:00Z`,
      );
      expect(temporalAnalysis.status).toBe(200);
      await expect(temporalAnalysis.json()).resolves.toMatchObject({
        retention_root: { urn: 'urn:sg:retention-root:root-1' },
        direct_commits: [],
        reachable_commits: [],
        reachable_manifests: [],
        direct_blobs: [],
        reachable_blobs: [],
        refs: [],
        tags: [],
        workspaces: [],
      });

      const gcPlan = await fetch(`${baseUrl}/v1/time-aware/retention-roots/root-1/gc-plan`);
      expect(gcPlan.status).toBe(200);
      await expect(gcPlan.json()).resolves.toMatchObject({
        retention_root: { urn: 'urn:sg:retention-root:root-1' },
        candidate_manifests: [
          {
            object: { urn: 'urn:sg:artifact-manifest:manifest-3' },
          },
        ],
        blockers: [
          { blocker_kind: 'REF', blocker: { urn: 'urn:sg:ref:main' } },
          { blocker_kind: 'RETENTION_ROOT', blocker: { urn: 'urn:sg:retention-root:root-2' } },
          { blocker_kind: 'TAG', blocker: { urn: 'urn:sg:tag:release-1' } },
          { blocker_kind: 'WORKSPACE', blocker: { urn: 'urn:sg:workspace:ws-alpha' } },
        ],
      });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

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
