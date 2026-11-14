import { describe, expect, it } from 'vitest';

import { buildAppDependencies } from '../../src/app/dependencies.js';
import { buildApp } from '../../src/app/server.js';
import { loadEnv } from '../../src/infrastructure/config/env.js';

async function buildTestApp() {
  const env = loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: ':memory:',
    REGISTRY_GRAPH_BACKEND: 'memory',
    TIME_AWARE_GRAPH_BACKEND: 'memory',
  });
  const deps = buildAppDependencies(env);
  await deps.ready();
  const { token } = await deps.apiKeys.create({ owner_label: 'Time Writer' });
  return { app: buildApp(deps), deps, token };
}

describe('time-aware routes', () => {
  it('serves navigation details, filtered lists, and draft workspace creation', async () => {
    const { app, deps, token } = await buildTestApp();

    const commits = await app.request('/v1/time-aware/commits');
    expect(commits.status).toBe(200);
    await expect(commits.json()).resolves.toEqual({ commits: [] });

    const refs = await app.request('/v1/time-aware/refs');
    expect(refs.status).toBe(200);
    await expect(refs.json()).resolves.toEqual({ refs: [] });

    const manifest = await deps.timeAwareCore.createArtifactManifest({
      manifest_id: 'manifest-1',
      author: 'pablo',
      artifact_blobs: [{ content: 'hello', encoding: 'utf8' }],
    });
    await deps.timeAwareCore.createArtifactManifest({
      manifest_id: 'manifest-2',
      author: 'pablo',
      artifact_blobs: [{ content: 'orphan', encoding: 'utf8' }],
    });
    const parent = await deps.timeAwareCore.createCommit({
      commit_id: 'c0',
      author: 'pablo',
      message: 'parent commit',
      transaction_time: '2026-03-01T00:00:00Z',
      valid_from: '2026-03-01T00:00:00Z',
      valid_to: '2026-03-05T00:00:00Z',
    });
    const commit = await deps.timeAwareCore.createCommit({
      commit_id: 'c1',
      author: 'pablo',
      message: 'seed commit',
      parent_commit_urns: [parent.value.urn],
      manifest_urns: [manifest.value.urn],
      transaction_time: '2026-03-05T00:00:00Z',
      valid_from: '2026-03-05T00:00:00Z',
    });
    await deps.timeAwareCore.createRef({
      ref_name: 'main',
      commit_urn: commit.value.urn,
      author: 'pablo',
    });
    await deps.timeAwareCore.createTag({
      tag_name: 'release-1',
      commit_urn: commit.value.urn,
      author: 'pablo',
    });

    const draftWorkspace = await app.request('/v1/time-aware/refs/main/workspaces/team-alpha/draft', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        owner: 'alpha',
        promotion_path: 'main>approved',
      }),
    });

    expect(draftWorkspace.status).toBe(201);
    await expect(draftWorkspace.json()).resolves.toMatchObject({
      created: true,
      workspace: {
        urn: 'urn:sg:workspace:team-alpha',
        properties: {
          workspace_id: 'team-alpha',
          owner: 'alpha',
          promotion_path: 'main>approved',
        },
      },
    });

    const workspaces = await app.request('/v1/time-aware/workspaces');
    expect(workspaces.status).toBe(200);
    await expect(workspaces.json()).resolves.toMatchObject({
      workspaces: [
        {
          urn: 'urn:sg:workspace:team-alpha',
        },
      ],
    });

    const commitDetails = await app.request('/v1/time-aware/commits/c1');
    expect(commitDetails.status).toBe(200);
    await expect(commitDetails.json()).resolves.toMatchObject({
      commit: { urn: 'urn:sg:commit:c1' },
      parent_commits: [{ urn: 'urn:sg:commit:c0' }],
      manifests: [{ urn: 'urn:sg:artifact-manifest:manifest-1' }],
      blobs: [{ urn: 'urn:sg:artifact-blob:sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824' }],
      refs: [{ urn: 'urn:sg:ref:main' }],
      tags: [{ urn: 'urn:sg:tag:release-1' }],
      workspaces: [{ urn: 'urn:sg:workspace:team-alpha' }],
    });

    const refDetails = await app.request('/v1/time-aware/refs/main');
    expect(refDetails.status).toBe(200);
    await expect(refDetails.json()).resolves.toMatchObject({
      ref: { urn: 'urn:sg:ref:main' },
      target_commit: { urn: 'urn:sg:commit:c1' },
      target_commit_parents: [{ urn: 'urn:sg:commit:c0' }],
    });

    const tagDetails = await app.request('/v1/time-aware/tags/release-1');
    expect(tagDetails.status).toBe(200);
    await expect(tagDetails.json()).resolves.toMatchObject({
      tag: { urn: 'urn:sg:tag:release-1' },
      target_commit: { urn: 'urn:sg:commit:c1' },
    });

    const workspaceDetails = await app.request('/v1/time-aware/workspaces/team-alpha');
    expect(workspaceDetails.status).toBe(200);
    await expect(workspaceDetails.json()).resolves.toMatchObject({
      workspace: { urn: 'urn:sg:workspace:team-alpha' },
      base_commit: { urn: 'urn:sg:commit:c1' },
    });

    const filteredRefs = await app.request('/v1/time-aware/refs?commit_urn=urn:sg:commit:c1');
    expect(filteredRefs.status).toBe(200);
    await expect(filteredRefs.json()).resolves.toMatchObject({
      refs: [{ urn: 'urn:sg:ref:main' }],
    });

    const filteredTags = await app.request('/v1/time-aware/tags?commit_urn=urn:sg:commit:c1');
    expect(filteredTags.status).toBe(200);
    await expect(filteredTags.json()).resolves.toMatchObject({
      tags: [{ urn: 'urn:sg:tag:release-1' }],
    });

    const filteredWorkspaces = await app.request('/v1/time-aware/workspaces?base_commit_urn=urn:sg:commit:c1');
    expect(filteredWorkspaces.status).toBe(200);
    await expect(filteredWorkspaces.json()).resolves.toMatchObject({
      workspaces: [{ urn: 'urn:sg:workspace:team-alpha' }],
    });

    const temporalCommits = await app.request(
      '/v1/time-aware/commits?valid_at=2026-03-03T00:00:00Z&transaction_as_of=2026-03-10T00:00:00Z',
    );
    expect(temporalCommits.status).toBe(200);
    await expect(temporalCommits.json()).resolves.toMatchObject({
      commits: [{ urn: 'urn:sg:commit:c0' }],
    });

    const temporalRefs = await app.request(
      '/v1/time-aware/refs?valid_at=2026-03-03T00:00:00Z&transaction_as_of=2026-03-10T00:00:00Z',
    );
    expect(temporalRefs.status).toBe(200);
    await expect(temporalRefs.json()).resolves.toEqual({ refs: [] });

    const temporalCommitDetails = await app.request(
      '/v1/time-aware/commits/c1?transaction_as_of=2026-03-04T00:00:00Z',
    );
    expect(temporalCommitDetails.status).toBe(404);

    const invalidTemporalRefs = await app.request('/v1/time-aware/refs?valid_at=not-a-date');
    expect(invalidTemporalRefs.status).toBe(400);
  });

  it('explains retention-root lineage analysis', async () => {
    const { app, deps } = await buildTestApp();

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

    const parent = await deps.timeAwareCore.createCommit({
      commit_id: 'c10',
      author: 'pablo',
      message: 'older commit',
      manifest_urns: [manifestParent.value.urn],
      transaction_time: '2026-03-01T00:00:00Z',
      valid_from: '2026-03-01T00:00:00Z',
    });
    const commit = await deps.timeAwareCore.createCommit({
      commit_id: 'c11',
      author: 'pablo',
      message: 'current commit',
      parent_commit_urns: [parent.value.urn],
      manifest_urns: [manifestCommit.value.urn],
      transaction_time: '2026-03-12T00:00:00Z',
      valid_from: '2026-03-12T00:00:00Z',
    });
    await deps.timeAwareCore.createRef({
      ref_name: 'stable',
      commit_urn: commit.value.urn,
      author: 'pablo',
    });
    await deps.timeAwareCore.createTag({
      tag_name: 'release-11',
      commit_urn: parent.value.urn,
      author: 'pablo',
    });
    await deps.timeAwareCore.createWorkspace({
      workspace_id: 'ops',
      base_commit_urn: commit.value.urn,
      owner: 'ops',
    });
    await deps.timeAwareCore.createRetentionRoot({
      root_id: 'root-1',
      root_kind: 'release',
      commit_urns: [commit.value.urn],
    });
    await deps.timeAwareCore.createRetentionRoot({
      root_id: 'root-2',
      root_kind: 'secondary',
      commit_urns: [parent.value.urn],
    });

    const analysis = await app.request('/v1/time-aware/retention-roots/root-1/analysis');
    expect(analysis.status).toBe(200);
    await expect(analysis.json()).resolves.toMatchObject({
      retention_root: { urn: 'urn:sg:retention-root:root-1' },
      direct_commits: [{ urn: 'urn:sg:commit:c11' }],
      reachable_commits: [{ urn: 'urn:sg:commit:c10' }, { urn: 'urn:sg:commit:c11' }],
      reachable_manifests: [
        { urn: 'urn:sg:artifact-manifest:manifest-1' },
        { urn: 'urn:sg:artifact-manifest:manifest-2' },
      ],
      direct_blobs: [],
      reachable_blobs: [
        { urn: 'urn:sg:artifact-blob:sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824' },
        { urn: 'urn:sg:artifact-blob:sha256:486ea46224d1bb4fb680f34f7c9ad96a8f24ec88be73ea8e5a6c65260e9cb8a7' },
      ],
      refs: [{ urn: 'urn:sg:ref:stable' }],
      tags: [{ urn: 'urn:sg:tag:release-11' }],
      workspaces: [{ urn: 'urn:sg:workspace:ops' }],
    });

    const temporalAnalysis = await app.request(
      '/v1/time-aware/retention-roots/root-1/analysis?valid_at=2026-03-10T00:00:00Z&transaction_as_of=2026-03-10T00:00:00Z',
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
      workspaces: [],
    });

    const gcPlan = await app.request('/v1/time-aware/retention-roots/root-1/gc-plan');
    expect(gcPlan.status).toBe(200);
    await expect(gcPlan.json()).resolves.toMatchObject({
      retention_root: { urn: 'urn:sg:retention-root:root-1' },
      candidate_manifests: [
        {
          object: { urn: 'urn:sg:artifact-manifest:manifest-3' },
        },
      ],
      blockers: [
        { blocker_kind: 'REF', blocker: { urn: 'urn:sg:ref:stable' } },
        { blocker_kind: 'RETENTION_ROOT', blocker: { urn: 'urn:sg:retention-root:root-2' } },
        { blocker_kind: 'TAG', blocker: { urn: 'urn:sg:tag:release-11' } },
        { blocker_kind: 'WORKSPACE', blocker: { urn: 'urn:sg:workspace:ops' } },
      ],
    });
  });
});
