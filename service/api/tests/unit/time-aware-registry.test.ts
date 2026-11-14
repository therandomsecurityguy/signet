import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { buildTimeAwareCore } from '../../../../service/registry/application/time-aware/build-time-aware-core.js';
import { FsCasArtifactStore } from '../../../../service/registry/domain/together/db/graph/freeform/registry/artifact-store.js';
import { InMemoryGraphStore } from '../../../../service/registry/domain/together/db/graph/freeform/registry/graph-store.js';

describe('time-aware registry core', () => {
  it('creates commit lineage and resolves navigation details', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'time-aware-core-'));
    try {
      const graph = new InMemoryGraphStore();
      const cas = new FsCasArtifactStore(path.join(tmp, 'objects'));
      const core = buildTimeAwareCore({ graph, cas }).service;

      const manifest = await core.createArtifactManifest({
        manifest_id: 'manifest-1',
        author: 'pablo',
        artifact_blobs: [{ content: 'hello', encoding: 'utf8', original_path: 'skills/example.md' }],
      });

      const parent = await core.createCommit({
        commit_id: 'c0',
        author: 'pablo',
        message: 'ancestor semantic state',
        transaction_time: '2026-03-01T00:00:00Z',
        valid_from: '2026-03-01T00:00:00Z',
        valid_to: '2026-03-05T00:00:00Z',
      });
      const commit = await core.createCommit({
        commit_id: 'c1',
        author: 'pablo',
        message: 'initial semantic state',
        parent_commit_urns: [parent.value.urn],
        manifest_urns: [manifest.value.urn],
        ontology_version: 'v1',
        validation_rules_version: 'vr1',
        transaction_time: '2026-03-05T00:00:00Z',
        valid_from: '2026-03-05T00:00:00Z',
      });
      expect(commit.created).toBe(true);

      const ref = await core.createRef({
        ref_name: 'main',
        commit_urn: commit.value.urn,
        author: 'pablo',
      });
      expect(ref.created).toBe(true);

      const tag = await core.createTag({
        tag_name: 'release-1',
        commit_urn: commit.value.urn,
        author: 'pablo',
      });
      expect(tag.created).toBe(true);

      const workspace = await core.createDraftWorkspaceFromRef({
        workspace_id: 'team-alpha',
        ref_name: 'main',
        owner: 'alpha',
      });
      expect(workspace.created).toBe(true);

      await expect(core.listCommits()).resolves.toMatchObject({
        commits: [{ urn: 'urn:tg:commit:c0' }, { urn: 'urn:tg:commit:c1' }],
      });
      await expect(core.listRefs()).resolves.toMatchObject({
        refs: [{ urn: 'urn:tg:ref:main' }],
      });
      await expect(core.listRefs({ commit_urn: commit.value.urn })).resolves.toMatchObject({
        refs: [{ urn: 'urn:tg:ref:main' }],
      });
      await expect(core.listTags()).resolves.toMatchObject({
        tags: [{ urn: 'urn:tg:tag:release-1' }],
      });
      await expect(core.listTags({ commit_urn: commit.value.urn })).resolves.toMatchObject({
        tags: [{ urn: 'urn:tg:tag:release-1' }],
      });
      await expect(core.listWorkspaces()).resolves.toMatchObject({
        workspaces: [{ urn: 'urn:tg:workspace:team-alpha' }],
      });
      await expect(core.listWorkspaces({ base_commit_urn: commit.value.urn })).resolves.toMatchObject({
        workspaces: [{ urn: 'urn:tg:workspace:team-alpha' }],
      });
      await expect(
        core.listCommits({
          valid_at: '2026-03-03T00:00:00Z',
          transaction_as_of: '2026-03-10T00:00:00Z',
        }),
      ).resolves.toMatchObject({
        commits: [{ urn: 'urn:tg:commit:c0' }],
      });
      await expect(
        core.listCommits({
          valid_at: '2026-03-06T00:00:00Z',
          transaction_as_of: '2026-03-04T00:00:00Z',
        }),
      ).resolves.toEqual({ commits: [] });
      await expect(
        core.listRefs({
          valid_at: '2026-03-03T00:00:00Z',
          transaction_as_of: '2026-03-10T00:00:00Z',
        }),
      ).resolves.toEqual({ refs: [] });
      await expect(
        core.getCommitDetails({
          commit_urn: commit.value.urn,
          transaction_as_of: '2026-03-04T00:00:00Z',
        }),
      ).resolves.toBeNull();

      await expect(core.getCommitDetails({ commit_urn: commit.value.urn })).resolves.toMatchObject({
        commit: { urn: 'urn:tg:commit:c1' },
        parent_commits: [{ urn: 'urn:tg:commit:c0' }],
        child_commits: [],
        manifests: [{ urn: 'urn:tg:artifact-manifest:manifest-1' }],
        blobs: [{ urn: 'urn:tg:artifact-blob:sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824' }],
        refs: [{ urn: 'urn:tg:ref:main' }],
        tags: [{ urn: 'urn:tg:tag:release-1' }],
        workspaces: [{ urn: 'urn:tg:workspace:team-alpha' }],
      });
      await expect(core.getCommitDetails({ commit_urn: parent.value.urn })).resolves.toMatchObject({
        commit: { urn: 'urn:tg:commit:c0' },
        child_commits: [{ urn: 'urn:tg:commit:c1' }],
      });
      await expect(core.getRefDetails({ ref_urn: ref.value.urn })).resolves.toMatchObject({
        ref: { urn: 'urn:tg:ref:main' },
        target_commit: { urn: 'urn:tg:commit:c1' },
        target_commit_parents: [{ urn: 'urn:tg:commit:c0' }],
      });
      await expect(core.getTagDetails({ tag_urn: tag.value.urn })).resolves.toMatchObject({
        tag: { urn: 'urn:tg:tag:release-1' },
        target_commit: { urn: 'urn:tg:commit:c1' },
      });
      await expect(core.getWorkspaceDetails({ workspace_urn: workspace.value.urn })).resolves.toMatchObject({
        workspace: { urn: 'urn:tg:workspace:team-alpha' },
        base_commit: { urn: 'urn:tg:commit:c1' },
      });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('creates retention roots and explains retained lineage', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'time-aware-storage-'));
    try {
      const graph = new InMemoryGraphStore();
      const cas = new FsCasArtifactStore(path.join(tmp, 'objects'));
      const core = buildTimeAwareCore({ graph, cas }).service;

      const manifestParent = await core.createArtifactManifest({
        manifest_id: 'manifest-1',
        author: 'pablo',
        artifact_blobs: [
          {
            content: 'hello',
            encoding: 'utf8',
            original_path: 'skills/example.md',
          },
        ],
      });
      expect(manifestParent.created).toBe(true);
      const manifestCommit = await core.createArtifactManifest({
        manifest_id: 'manifest-2',
        author: 'pablo',
        artifact_blobs: [
          {
            content: 'world',
            encoding: 'utf8',
            original_path: 'skills/example-2.md',
          },
        ],
      });
      expect(manifestCommit.created).toBe(true);
      const manifestOrphan = await core.createArtifactManifest({
        manifest_id: 'manifest-3',
        author: 'pablo',
        artifact_blobs: [
          {
            content: 'orphan',
            encoding: 'utf8',
            original_path: 'skills/orphan.md',
          },
        ],
      });
      expect(manifestOrphan.created).toBe(true);

      const parent = await core.createCommit({
        commit_id: 'c1',
        author: 'pablo',
        message: 'root parent',
        manifest_urns: [manifestParent.value.urn],
        transaction_time: '2026-03-01T00:00:00Z',
        valid_from: '2026-03-01T00:00:00Z',
      });
      const commit = await core.createCommit({
        commit_id: 'c2',
        author: 'pablo',
        message: 'state for retention',
        parent_commit_urns: [parent.value.urn],
        manifest_urns: [manifestCommit.value.urn],
        transaction_time: '2026-03-12T00:00:00Z',
        valid_from: '2026-03-12T00:00:00Z',
      });
      await core.createRef({
        ref_name: 'main',
        commit_urn: commit.value.urn,
        author: 'pablo',
      });
      await core.createTag({
        tag_name: 'release-2',
        commit_urn: parent.value.urn,
        author: 'pablo',
      });
      await core.createWorkspace({
        workspace_id: 'ops',
        base_commit_urn: commit.value.urn,
        owner: 'ops',
      });

      const root = await core.createRetentionRoot({
        root_id: 'root-1',
        root_kind: 'main',
        commit_urns: [commit.value.urn],
      });
      expect(root.created).toBe(true);
      await core.createRetentionRoot({
        root_id: 'root-2',
        root_kind: 'secondary',
        commit_urns: [parent.value.urn],
      });

      const gc = await core.createGcJob({
        job_id: 'gc-1',
        author: 'pablo',
        retention_root_urns: [root.value.urn],
        grace_period_days: 7,
      });
      expect(gc.created).toBe(true);

      await expect(core.listArtifactManifests()).resolves.toMatchObject({
        manifests: [
          { urn: 'urn:tg:artifact-manifest:manifest-1' },
          { urn: 'urn:tg:artifact-manifest:manifest-2' },
          { urn: 'urn:tg:artifact-manifest:manifest-3' },
        ],
      });
      await expect(core.listRetentionRoots()).resolves.toMatchObject({
        retention_roots: [{ urn: 'urn:tg:retention-root:root-1' }, { urn: 'urn:tg:retention-root:root-2' }],
      });
      await expect(core.listGcJobs()).resolves.toMatchObject({
        gc_jobs: [{ urn: 'urn:tg:gc-job:gc-1' }],
      });
      await expect(core.analyzeRetentionRoot({ retention_root_urn: root.value.urn })).resolves.toMatchObject({
        retention_root: { urn: 'urn:tg:retention-root:root-1' },
        direct_commits: [{ urn: 'urn:tg:commit:c2' }],
        reachable_commits: [{ urn: 'urn:tg:commit:c1' }, { urn: 'urn:tg:commit:c2' }],
        reachable_manifests: [
          { urn: 'urn:tg:artifact-manifest:manifest-1' },
          { urn: 'urn:tg:artifact-manifest:manifest-2' },
        ],
        direct_blobs: [],
        reachable_blobs: [
          { urn: 'urn:tg:artifact-blob:sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824' },
          { urn: 'urn:tg:artifact-blob:sha256:486ea46224d1bb4fb680f34f7c9ad96a8f24ec88be73ea8e5a6c65260e9cb8a7' },
        ],
        refs: [{ urn: 'urn:tg:ref:main' }],
        tags: [{ urn: 'urn:tg:tag:release-2' }],
        workspaces: [{ urn: 'urn:tg:workspace:ops' }],
      });
      await expect(
        core.analyzeRetentionRoot({
          retention_root_urn: root.value.urn,
          valid_at: '2026-03-10T00:00:00Z',
          transaction_as_of: '2026-03-10T00:00:00Z',
        }),
      ).resolves.toMatchObject({
        retention_root: { urn: 'urn:tg:retention-root:root-1' },
        direct_commits: [],
        reachable_commits: [],
        reachable_manifests: [],
        direct_blobs: [],
        reachable_blobs: [],
        refs: [],
        workspaces: [],
      });
      await expect(core.previewGcPlan({ retention_root_urn: root.value.urn })).resolves.toMatchObject({
        retention_root: { urn: 'urn:tg:retention-root:root-1' },
        protected_commits: [
          {
            object: { urn: 'urn:tg:commit:c1' },
            reasons: [{ code: 'ANCESTOR_OF_RETAINED_COMMIT' }],
          },
          {
            object: { urn: 'urn:tg:commit:c2' },
            reasons: [{ code: 'DIRECT_RETENTION_ROOT_COMMIT' }],
          },
        ],
        protected_manifests: [
          {
            object: { urn: 'urn:tg:artifact-manifest:manifest-1' },
            reasons: [{ code: 'INCLUDED_BY_PROTECTED_COMMIT' }],
          },
          {
            object: { urn: 'urn:tg:artifact-manifest:manifest-2' },
            reasons: [{ code: 'INCLUDED_BY_PROTECTED_COMMIT' }],
          },
        ],
        protected_blobs: [
          {
            object: { urn: 'urn:tg:artifact-blob:sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824' },
          },
          {
            object: { urn: 'urn:tg:artifact-blob:sha256:486ea46224d1bb4fb680f34f7c9ad96a8f24ec88be73ea8e5a6c65260e9cb8a7' },
          },
        ],
        candidate_manifests: [
          {
            object: { urn: 'urn:tg:artifact-manifest:manifest-3' },
            reasons: [{ code: 'UNPROTECTED_MANIFEST' }],
          },
        ],
        candidate_blobs: [
          {
            object: { urn: 'urn:tg:artifact-blob:sha256:88f6811ab5d8fc6d3177f9b7609ae0fcebfda187e5046b62d38bb539e88b74d7' },
            reasons: [{ code: 'UNPROTECTED_BLOB' }],
          },
        ],
        blockers: [
          { blocker_kind: 'REF', blocker: { urn: 'urn:tg:ref:main' } },
          { blocker_kind: 'RETENTION_ROOT', blocker: { urn: 'urn:tg:retention-root:root-2' } },
          { blocker_kind: 'TAG', blocker: { urn: 'urn:tg:tag:release-2' } },
          { blocker_kind: 'WORKSPACE', blocker: { urn: 'urn:tg:workspace:ops' } },
        ],
      });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
