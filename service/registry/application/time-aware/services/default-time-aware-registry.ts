import { createHash } from 'node:crypto';

import type { ArtifactStore } from '../../../domain/together/db/graph/freeform/registry/artifact-store.js';
import type { GraphNode, GraphStore } from '../../../domain/together/db/graph/freeform/registry/graph-store.js';
import {
  artifactBlobUrn,
  artifactManifestUrn,
  commitUrn,
  gcJobUrn,
  refUrn,
  retentionRootUrn,
  tagUrn,
  workspaceUrn,
} from '../../../domain/together/db/graph/freeform/registry/urn.js';
import { TimeAwareRegistryError } from '../errors/time-aware-registry-error.js';
import type {
  CreateResult,
  DraftWorkspaceFromRefInput,
  TimeAwareCommitDetails,
  TimeAwareArtifactBlobInput,
  TimeAwareCommitInput,
  TimeAwareGcPlanBlocker,
  TimeAwareGcPlanItem,
  TimeAwareGcPlanPreview,
  TimeAwareGcPlanReason,
  TimeAwareGcJobInput,
  TimeAwareManifestInput,
  TimeAwareRefDetails,
  TimeAwareRefInput,
  TimeAwareRegistry,
  TimeAwareRetentionRootAnalysis,
  TimeAwareRetentionRootInput,
  TimeAwareSummary,
  TimeAwareTagDetails,
  TimeAwareTagInput,
  TimeAwareTemporalQuery,
  TimeAwareWorkspaceDetails,
  TimeAwareWorkspaceInput,
} from '../ports/time-aware-registry.js';

export class DefaultTimeAwareRegistry implements TimeAwareRegistry {
  constructor(
    private readonly deps: {
      graph: GraphStore;
      cas: ArtifactStore;
    },
  ) {}

  async createCommit(input: TimeAwareCommitInput): Promise<CreateResult<TimeAwareSummary>> {
    const urn = commitUrn(input.commit_id);
    const existing = await this.deps.graph.getNode(urn);
    const expected_parent_urns = input.parent_commit_urns ?? [];
    const expected_manifest_urns = input.manifest_urns ?? [];
    const props = {
      commit_id: input.commit_id,
      author: input.author,
      message: input.message,
      ...(input.ontology_version ? { ontology_version: input.ontology_version } : {}),
      ...(input.validation_rules_version ? { validation_rules_version: input.validation_rules_version } : {}),
      ...(input.transaction_time ? { transaction_time: input.transaction_time } : {}),
      ...(input.valid_from ? { valid_from: input.valid_from } : {}),
      ...(input.valid_to ? { valid_to: input.valid_to } : {}),
    };

    if (existing) {
      if (
        sameProperties(existing.properties, props) &&
        (await this.matchesOutgoingTargets(urn, 'sg:parentCommit', expected_parent_urns)) &&
        (await this.matchesOutgoingTargets(urn, 'sg:includesManifest', expected_manifest_urns))
      ) {
        return { value: toSummary(existing), created: false };
      }
      throw new TimeAwareRegistryError('COMMIT_CREATE_CONFLICT', 'Commit already exists with different state.');
    }

    await this.deps.graph.upsertNode({
      urn,
      entity_type: 'COMMIT',
      properties: props,
    });
    for (const parent of expected_parent_urns) {
      await this.deps.graph.upsertEdge({
        from_urn: urn,
        to_urn: parent,
        predicate: 'sg:parentCommit',
        properties: {},
      });
    }
    for (const manifest_urn of expected_manifest_urns) {
      await this.deps.graph.upsertEdge({
        from_urn: urn,
        to_urn: manifest_urn,
        predicate: 'sg:includesManifest',
        properties: {},
      });
    }
    return { value: requiredSummary(await this.deps.graph.getNode(urn), 'COMMIT_CREATE_FAILED'), created: true };
  }

  async getCommit(input: { commit_urn: string }): Promise<TimeAwareSummary | null> {
    return mapNode(await this.deps.graph.getNode(input.commit_urn));
  }

  async getCommitDetails(input: { commit_urn: string } & TimeAwareTemporalQuery): Promise<TimeAwareCommitDetails | null> {
    const commit = await this.deps.graph.getNode(input.commit_urn);
    if (!commit || !matchesTemporalQuery(commit, input)) return null;

    const manifests = await this.resolveCommitManifests([input.commit_urn]);
    const blobs = await this.resolveManifestBlobs(manifests.map((manifest) => manifest.urn));

    return {
      commit: toSummary(commit),
      parent_commits: await this.resolveTargets(input.commit_urn, 'sg:parentCommit', input),
      child_commits: await this.resolveSources(input.commit_urn, 'sg:parentCommit', 'COMMIT', input),
      manifests,
      blobs,
      refs: await this.resolveSources(input.commit_urn, 'sg:pointsToCommit', 'REF'),
      tags: await this.resolveSources(input.commit_urn, 'sg:pointsToCommit', 'TAG'),
      workspaces: await this.resolveSources(input.commit_urn, 'sg:basedOnCommit', 'WORKSPACE'),
    };
  }

  async listCommits(input?: TimeAwareTemporalQuery): Promise<{ commits: TimeAwareSummary[] }> {
    return { commits: await listType(this.deps.graph, 'COMMIT', input) };
  }

  async createRef(input: TimeAwareRefInput): Promise<CreateResult<TimeAwareSummary>> {
    const urn = refUrn(input.ref_name);
    return await this.upsertPointingNode({
      urn,
      entity_type: 'REF',
      properties: {
        ref_name: input.ref_name,
        author: input.author,
        updated_at: nowIso(),
      },
      target_urn: input.commit_urn,
      predicate: 'sg:pointsToCommit',
      conflictCode: 'REF_CREATE_CONFLICT',
      createdCode: 'REF_CREATE_FAILED',
    });
  }

  async getRef(input: { ref_urn: string }): Promise<TimeAwareSummary | null> {
    return mapNode(await this.deps.graph.getNode(input.ref_urn));
  }

  async getRefDetails(input: { ref_urn: string }): Promise<TimeAwareRefDetails | null> {
    const ref = await this.deps.graph.getNode(input.ref_urn);
    if (!ref) return null;

    const target_commit = await this.resolveSingleTarget(input.ref_urn, 'sg:pointsToCommit');

    return {
      ref: toSummary(ref),
      target_commit,
      target_commit_parents: target_commit ? await this.resolveTargets(target_commit.urn, 'sg:parentCommit') : [],
    };
  }

  async listRefs(input?: { commit_urn?: string } & TimeAwareTemporalQuery): Promise<{ refs: TimeAwareSummary[] }> {
    return { refs: await this.listPointersToCommit('REF', 'sg:pointsToCommit', input?.commit_urn, input) };
  }

  async createTag(input: TimeAwareTagInput): Promise<CreateResult<TimeAwareSummary>> {
    const urn = tagUrn(input.tag_name);
    return await this.upsertPointingNode({
      urn,
      entity_type: 'TAG',
      properties: {
        tag_name: input.tag_name,
        author: input.author,
        ...(input.immutable_reason ? { immutable_reason: input.immutable_reason } : {}),
      },
      target_urn: input.commit_urn,
      predicate: 'sg:pointsToCommit',
      conflictCode: 'TAG_CREATE_CONFLICT',
      createdCode: 'TAG_CREATE_FAILED',
    });
  }

  async getTag(input: { tag_urn: string }): Promise<TimeAwareSummary | null> {
    return mapNode(await this.deps.graph.getNode(input.tag_urn));
  }

  async getTagDetails(input: { tag_urn: string }): Promise<TimeAwareTagDetails | null> {
    const tag = await this.deps.graph.getNode(input.tag_urn);
    if (!tag) return null;

    const target_commit = await this.resolveSingleTarget(input.tag_urn, 'sg:pointsToCommit');

    return {
      tag: toSummary(tag),
      target_commit,
      target_commit_parents: target_commit ? await this.resolveTargets(target_commit.urn, 'sg:parentCommit') : [],
    };
  }

  async listTags(input?: { commit_urn?: string } & TimeAwareTemporalQuery): Promise<{ tags: TimeAwareSummary[] }> {
    return { tags: await this.listPointersToCommit('TAG', 'sg:pointsToCommit', input?.commit_urn, input) };
  }

  async createWorkspace(input: TimeAwareWorkspaceInput): Promise<CreateResult<TimeAwareSummary>> {
    const urn = workspaceUrn(input.workspace_id);
    return await this.upsertPointingNode({
      urn,
      entity_type: 'WORKSPACE',
      properties: {
        workspace_id: input.workspace_id,
        owner: input.owner,
        ...(input.expires_at ? { expires_at: input.expires_at } : {}),
        ...(input.promotion_path ? { promotion_path: input.promotion_path } : {}),
      },
      target_urn: input.base_commit_urn,
      predicate: 'sg:basedOnCommit',
      conflictCode: 'WORKSPACE_CREATE_CONFLICT',
      createdCode: 'WORKSPACE_CREATE_FAILED',
    });
  }

  async createDraftWorkspaceFromRef(input: DraftWorkspaceFromRefInput): Promise<CreateResult<TimeAwareSummary>> {
    const ref = await this.deps.graph.getNode(refUrn(input.ref_name));
    if (!ref) {
      throw new TimeAwareRegistryError('REF_NOT_FOUND', `Ref not found: ${input.ref_name}`);
    }
    const edges = await this.deps.graph.listEdgesFrom(ref.urn, 'sg:pointsToCommit');
    const commit = edges[0]?.to_urn;
    if (!commit) {
      throw new TimeAwareRegistryError('REF_TARGET_NOT_FOUND', `Ref has no target commit: ${input.ref_name}`);
    }
    return await this.createWorkspace({
      workspace_id: input.workspace_id,
      base_commit_urn: commit,
      owner: input.owner,
      ...(input.expires_at ? { expires_at: input.expires_at } : {}),
      ...(input.promotion_path ? { promotion_path: input.promotion_path } : {}),
    });
  }

  async getWorkspace(input: { workspace_urn: string }): Promise<TimeAwareSummary | null> {
    return mapNode(await this.deps.graph.getNode(input.workspace_urn));
  }

  async getWorkspaceDetails(input: { workspace_urn: string }): Promise<TimeAwareWorkspaceDetails | null> {
    const workspace = await this.deps.graph.getNode(input.workspace_urn);
    if (!workspace) return null;

    const base_commit = await this.resolveSingleTarget(input.workspace_urn, 'sg:basedOnCommit');

    return {
      workspace: toSummary(workspace),
      base_commit,
      base_commit_parents: base_commit ? await this.resolveTargets(base_commit.urn, 'sg:parentCommit') : [],
    };
  }

  async listWorkspaces(input?: { base_commit_urn?: string } & TimeAwareTemporalQuery): Promise<{ workspaces: TimeAwareSummary[] }> {
    return {
      workspaces: await this.listPointersToCommit('WORKSPACE', 'sg:basedOnCommit', input?.base_commit_urn, input),
    };
  }

  async createArtifactManifest(input: TimeAwareManifestInput): Promise<CreateResult<TimeAwareSummary>> {
    const urn = artifactManifestUrn(input.manifest_id);
    const existing = await this.deps.graph.getNode(urn);
    if (existing) {
      return { value: toSummary(existing), created: false };
    }

    await this.deps.graph.upsertNode({
      urn,
      entity_type: 'ARTIFACT_MANIFEST',
      properties: {
        manifest_id: input.manifest_id,
        author: input.author,
        created_at: nowIso(),
      },
    });

    for (const blob of input.artifact_blobs) {
      const blobRecord = await this.persistBlob(blob);
      const blobUrn = artifactBlobUrn(blobRecord.sha256);
      await this.deps.graph.upsertNode({
        urn: blobUrn,
        entity_type: 'ARTIFACT_BLOB',
        properties: {
          sha256: blobRecord.sha256,
          size_bytes: blobRecord.size_bytes,
          ...(blobRecord.media_type ? { media_type: blobRecord.media_type } : {}),
          ...(blobRecord.original_path ? { original_path: blobRecord.original_path } : {}),
        },
      });
      await this.deps.graph.upsertEdge({
        from_urn: urn,
        to_urn: blobUrn,
        predicate: 'sg:containsBlob',
        properties: {},
      });
    }

    return { value: requiredSummary(await this.deps.graph.getNode(urn), 'MANIFEST_CREATE_FAILED'), created: true };
  }

  async getArtifactManifest(input: { manifest_urn: string }): Promise<TimeAwareSummary | null> {
    return mapNode(await this.deps.graph.getNode(input.manifest_urn));
  }

  async listArtifactManifests(): Promise<{ manifests: TimeAwareSummary[] }> {
    return { manifests: await listType(this.deps.graph, 'ARTIFACT_MANIFEST') };
  }

  async createRetentionRoot(input: TimeAwareRetentionRootInput): Promise<CreateResult<TimeAwareSummary>> {
    const urn = retentionRootUrn(input.root_id);
    const existing = await this.deps.graph.getNode(urn);
    const props = {
      root_id: input.root_id,
      root_kind: input.root_kind,
      ...(input.description ? { description: input.description } : {}),
    };
    if (existing) {
      if (sameProperties(existing.properties, props)) {
        return { value: toSummary(existing), created: false };
      }
      throw new TimeAwareRegistryError('RETENTION_ROOT_CREATE_CONFLICT', 'Retention root already exists with different state.');
    }

    await this.deps.graph.upsertNode({
      urn,
      entity_type: 'RETENTION_ROOT',
      properties: props,
    });
    for (const commit of input.commit_urns ?? []) {
      await this.deps.graph.upsertEdge({
        from_urn: urn,
        to_urn: commit,
        predicate: 'sg:keepsCommit',
        properties: {},
      });
    }
    for (const blob of input.blob_urns ?? []) {
      await this.deps.graph.upsertEdge({
        from_urn: urn,
        to_urn: blob,
        predicate: 'sg:keepsBlob',
        properties: {},
      });
    }
    return { value: requiredSummary(await this.deps.graph.getNode(urn), 'RETENTION_ROOT_CREATE_FAILED'), created: true };
  }

  async getRetentionRoot(input: { retention_root_urn: string }): Promise<TimeAwareSummary | null> {
    return mapNode(await this.deps.graph.getNode(input.retention_root_urn));
  }

  async analyzeRetentionRoot(input: { retention_root_urn: string } & TimeAwareTemporalQuery): Promise<TimeAwareRetentionRootAnalysis | null> {
    const retention_root = await this.deps.graph.getNode(input.retention_root_urn);
    if (!retention_root) return null;

    const direct_commits = await this.resolveTargets(input.retention_root_urn, 'sg:keepsCommit', input);
    const direct_blobs = await this.resolveTargets(input.retention_root_urn, 'sg:keepsBlob');
    const reachable_commits = await this.collectReachableCommits(direct_commits.map((commit) => commit.urn), input);
    const reachable_manifests = await this.resolveCommitManifests(reachable_commits.map((commit) => commit.urn));
    const manifest_blobs = await this.resolveManifestBlobs(reachable_manifests.map((manifest) => manifest.urn));
    const commit_urns = reachable_commits.map((commit) => commit.urn);
    const reachable_blobs = dedupeSummaries([...direct_blobs, ...manifest_blobs]);

    return {
      retention_root: toSummary(retention_root),
      direct_commits,
      reachable_commits,
      reachable_manifests,
      direct_blobs,
      reachable_blobs,
      refs: await this.resolvePointerSet(commit_urns, 'REF', 'sg:pointsToCommit'),
      tags: await this.resolvePointerSet(commit_urns, 'TAG', 'sg:pointsToCommit'),
      workspaces: await this.resolvePointerSet(commit_urns, 'WORKSPACE', 'sg:basedOnCommit'),
    };
  }

  async previewGcPlan(input: { retention_root_urn: string } & TimeAwareTemporalQuery): Promise<TimeAwareGcPlanPreview | null> {
    const selected = await this.analyzeRetentionRoot(input);
    if (!selected) return null;

    const all_roots = await listType(this.deps.graph, 'RETENTION_ROOT');
    const global_analyses = compact(
      await Promise.all(
        all_roots.map((root) =>
          this.analyzeRetentionRoot({
            retention_root_urn: root.urn,
            ...(input.valid_at ? { valid_at: input.valid_at } : {}),
            ...(input.transaction_as_of ? { transaction_as_of: input.transaction_as_of } : {}),
          }),
        ),
      ),
    );

    const global_protected_manifests = dedupeSummaries(global_analyses.flatMap((analysis) => analysis.reachable_manifests));
    const global_protected_blobs = dedupeSummaries(global_analyses.flatMap((analysis) => analysis.reachable_blobs));
    const all_manifests = await listType(this.deps.graph, 'ARTIFACT_MANIFEST');
    const all_blobs = await listType(this.deps.graph, 'ARTIFACT_BLOB');

    const commit_ancestor_origins = await this.collectProtectedCommitOrigins(selected.direct_commits.map((commit) => commit.urn), input);
    const manifest_commit_origins = await this.collectManifestCommitOrigins(selected.reachable_commits.map((commit) => commit.urn));
    const blob_manifest_origins = await this.collectBlobManifestOrigins(selected.reachable_manifests.map((manifest) => manifest.urn));
    const other_root_blockers = this.buildOtherRootBlockers(selected, global_analyses);

    return {
      retention_root: selected.retention_root,
      protected_commits: selected.reachable_commits.map((commit) =>
        toPlanItem(commit, this.commitProtectionReasons(commit, selected.direct_commits, commit_ancestor_origins, selected.retention_root.urn)),
      ),
      protected_manifests: selected.reachable_manifests.map((manifest) =>
        toPlanItem(manifest, this.manifestProtectionReasons(manifest, manifest_commit_origins)),
      ),
      protected_blobs: selected.reachable_blobs.map((blob) =>
        toPlanItem(blob, this.blobProtectionReasons(blob, selected.direct_blobs, blob_manifest_origins, selected.retention_root.urn)),
      ),
      candidate_manifests: all_manifests
        .filter((manifest) => !global_protected_manifests.some((protected_manifest) => protected_manifest.urn === manifest.urn))
        .map((manifest) => toPlanItem(manifest, [globalCandidateReason('manifest', manifest.urn)])),
      candidate_blobs: all_blobs
        .filter((blob) => !global_protected_blobs.some((protected_blob) => protected_blob.urn === blob.urn))
        .map((blob) => toPlanItem(blob, [globalCandidateReason('blob', blob.urn)])),
      blockers: dedupeBlockers([
        ...this.pointerBlockers('REF', selected.refs),
        ...this.pointerBlockers('TAG', selected.tags),
        ...this.pointerBlockers('WORKSPACE', selected.workspaces),
        ...other_root_blockers,
      ]),
    };
  }

  async listRetentionRoots(): Promise<{ retention_roots: TimeAwareSummary[] }> {
    return { retention_roots: await listType(this.deps.graph, 'RETENTION_ROOT') };
  }

  async createGcJob(input: TimeAwareGcJobInput): Promise<CreateResult<TimeAwareSummary>> {
    const urn = gcJobUrn(input.job_id);
    const existing = await this.deps.graph.getNode(urn);
    const props = {
      job_id: input.job_id,
      author: input.author,
      status: 'planned',
      created_at: nowIso(),
      ...(typeof input.grace_period_days === 'number' ? { grace_period_days: input.grace_period_days } : {}),
    };
    if (existing) {
      // Idempotency compares the caller-derived fields only; created_at is
      // stamped on first creation and must not participate.
      const { created_at: _existingCreatedAt, ...existingComparable } = existing.properties;
      const { created_at: _propsCreatedAt, ...propsComparable } = props;
      if (sameProperties(existingComparable, propsComparable)) {
        return { value: toSummary(existing), created: false };
      }
      throw new TimeAwareRegistryError('GC_JOB_CREATE_CONFLICT', 'GC job already exists with different state.');
    }

    await this.deps.graph.upsertNode({
      urn,
      entity_type: 'GC_JOB',
      properties: props,
    });
    for (const rootUrn of input.retention_root_urns) {
      await this.deps.graph.upsertEdge({
        from_urn: urn,
        to_urn: rootUrn,
        predicate: 'sg:analyzesRetentionRoot',
        properties: {},
      });
    }
    return { value: requiredSummary(await this.deps.graph.getNode(urn), 'GC_JOB_CREATE_FAILED'), created: true };
  }

  async getGcJob(input: { gc_job_urn: string }): Promise<TimeAwareSummary | null> {
    return mapNode(await this.deps.graph.getNode(input.gc_job_urn));
  }

  async executeGcJob(input: { job_id: string; author: string }): Promise<TimeAwareSummary> {
    const urn = gcJobUrn(input.job_id);
    const existing = await this.deps.graph.getNode(urn);
    if (!existing || existing.entity_type !== 'GC_JOB') {
      throw new TimeAwareRegistryError('GC_JOB_NOT_FOUND', `GC job not found: ${input.job_id}`);
    }
    const status = existing.properties['status'];
    if (status === 'completed') {
      // Idempotent: an already-executed job is returned unchanged.
      return toSummary(existing);
    }
    if (status !== 'planned') {
      throw new TimeAwareRegistryError('GC_JOB_EXECUTE_CONFLICT', `GC job cannot execute from status ${String(status)}.`);
    }

    // Non-destructive execution seam: the job durably records the collection
    // plan computed from each linked retention root. Artifact bytes are not
    // deleted; physical reclamation remains an operator-controlled follow-up.
    const rootEdges = await this.deps.graph.listEdgesFrom(urn, 'sg:analyzesRetentionRoot');
    let candidateBlobCount = 0;
    let protectedBlobCount = 0;
    let blockerCount = 0;
    let analyzedRootCount = 0;
    for (const edge of rootEdges) {
      const plan = await this.previewGcPlan({ retention_root_urn: edge.to_urn });
      if (!plan) continue;
      analyzedRootCount += 1;
      candidateBlobCount += plan.candidate_blobs.length;
      protectedBlobCount += plan.protected_blobs.length;
      blockerCount += plan.blockers.length;
    }

    await this.deps.graph.upsertNode({
      urn,
      entity_type: 'GC_JOB',
      properties: {
        ...existing.properties,
        status: 'completed',
        executed_at: nowIso(),
        executed_by: input.author,
        execution_mode: 'plan_only',
        analyzed_root_count: analyzedRootCount,
        candidate_blob_count: candidateBlobCount,
        protected_blob_count: protectedBlobCount,
        blocker_count: blockerCount,
      },
    });
    return requiredSummary(await this.deps.graph.getNode(urn), 'GC_JOB_EXECUTE_FAILED');
  }

  async listGcJobs(): Promise<{ gc_jobs: TimeAwareSummary[] }> {
    return { gc_jobs: await listType(this.deps.graph, 'GC_JOB') };
  }

  private async upsertPointingNode(input: {
    urn: string;
    entity_type: GraphNode['entity_type'];
    properties: Record<string, unknown>;
    target_urn: string;
    predicate: string;
    conflictCode: string;
    createdCode: string;
  }): Promise<CreateResult<TimeAwareSummary>> {
    const existing = await this.deps.graph.getNode(input.urn);
    if (existing) {
      if (sameProperties(existing.properties, input.properties)) {
        const existingEdges = await this.deps.graph.listEdgesFrom(input.urn, input.predicate);
        if (existingEdges[0]?.to_urn === input.target_urn) {
          return { value: toSummary(existing), created: false };
        }
      }
      throw new TimeAwareRegistryError(input.conflictCode, `${input.entity_type} already exists with different state.`);
    }

    await this.deps.graph.upsertNode({
      urn: input.urn,
      entity_type: input.entity_type,
      properties: input.properties,
    });
    await this.deps.graph.upsertEdge({
      from_urn: input.urn,
      to_urn: input.target_urn,
      predicate: input.predicate,
      properties: {},
    });

    return { value: requiredSummary(await this.deps.graph.getNode(input.urn), input.createdCode), created: true };
  }

  private async persistBlob(input: TimeAwareArtifactBlobInput) {
    return await this.deps.cas.put({
      bytes: decodeArtifactInput(input.content, input.encoding),
      ...(input.media_type ? { media_type: input.media_type } : {}),
      ...(input.original_path ? { original_path: input.original_path } : {}),
    });
  }

  private async matchesOutgoingTargets(from_urn: string, predicate: string, expected_urns: string[]): Promise<boolean> {
    const edges = await this.deps.graph.listEdgesFrom(from_urn, predicate);
    return sameValues(
      edges.map((edge) => edge.to_urn),
      expected_urns,
    );
  }

  private async resolveSingleTarget(from_urn: string, predicate: string): Promise<TimeAwareSummary | null> {
    const targets = await this.resolveTargets(from_urn, predicate);
    return targets[0] ?? null;
  }

  private async resolveTargets(
    from_urn: string,
    predicate: string,
    temporal?: TimeAwareTemporalQuery,
  ): Promise<TimeAwareSummary[]> {
    const edges = await this.deps.graph.listEdgesFrom(from_urn, predicate);
    return await this.resolveSummaries(edges.map((edge) => edge.to_urn), temporal);
  }

  private async resolveSources(
    to_urn: string,
    predicate: string,
    entity_type: GraphNode['entity_type'],
    temporal?: TimeAwareTemporalQuery,
  ): Promise<TimeAwareSummary[]> {
    const edges = await this.deps.graph.listEdgesTo(to_urn, predicate);
    const source_urns: string[] = [];
    for (const edge of edges) {
      const node = await this.deps.graph.getNode(edge.from_urn);
      if (node?.entity_type === entity_type && (!temporal || matchesTemporalQuery(node, temporal))) {
        source_urns.push(node.urn);
      }
    }
    return await this.resolveSummaries(source_urns);
  }

  private async listPointersToCommit(
    entity_type: GraphNode['entity_type'],
    predicate: string,
    commit_urn?: string,
    temporal?: TimeAwareTemporalQuery,
  ): Promise<TimeAwareSummary[]> {
    if (commit_urn) {
      const commit = await this.deps.graph.getNode(commit_urn);
      if (!commit || (temporal && !matchesTemporalQuery(commit, temporal))) {
        return [];
      }

      return await this.resolveSources(commit_urn, predicate, entity_type);
    }

    const pointers = await listType(this.deps.graph, entity_type);
    if (!temporal) return pointers;

    const filtered: TimeAwareSummary[] = [];
    for (const pointer of pointers) {
      const target = await this.resolveSingleTarget(pointer.urn, predicate);
      if (!target) continue;
      const targetNode = await this.deps.graph.getNode(target.urn);
      if (targetNode && matchesTemporalQuery(targetNode, temporal)) {
        filtered.push(pointer);
      }
    }

    return filtered.sort((left, right) => left.urn.localeCompare(right.urn));
  }

  private async resolveCommitManifests(commit_urns: string[]): Promise<TimeAwareSummary[]> {
    const manifest_urns = new Set<string>();
    for (const commit_urn of commit_urns) {
      const edges = await this.deps.graph.listEdgesFrom(commit_urn, 'sg:includesManifest');
      for (const edge of edges) {
        manifest_urns.add(edge.to_urn);
      }
    }

    return await this.resolveSummaries([...manifest_urns]);
  }

  private async resolveManifestBlobs(manifest_urns: string[]): Promise<TimeAwareSummary[]> {
    const blob_urns = new Set<string>();
    for (const manifest_urn of manifest_urns) {
      const edges = await this.deps.graph.listEdgesFrom(manifest_urn, 'sg:containsBlob');
      for (const edge of edges) {
        blob_urns.add(edge.to_urn);
      }
    }

    return await this.resolveSummaries([...blob_urns]);
  }

  private async collectReachableCommits(
    seed_commit_urns: string[],
    temporal?: TimeAwareTemporalQuery,
  ): Promise<TimeAwareSummary[]> {
    const pending = [...seed_commit_urns];
    const seen = new Set<string>();

    while (pending.length > 0) {
      const commit_urn = pending.shift();
      if (!commit_urn || seen.has(commit_urn)) continue;
      const commit = await this.deps.graph.getNode(commit_urn);
      if (!commit || (temporal && !matchesTemporalQuery(commit, temporal))) continue;
      seen.add(commit_urn);

      const parent_edges = await this.deps.graph.listEdgesFrom(commit_urn, 'sg:parentCommit');
      for (const edge of parent_edges) {
        if (!seen.has(edge.to_urn)) {
          pending.push(edge.to_urn);
        }
      }
    }

    return await this.resolveSummaries([...seen]);
  }

  private async resolvePointerSet(
    commit_urns: string[],
    entity_type: GraphNode['entity_type'],
    predicate: string,
  ): Promise<TimeAwareSummary[]> {
    const collected = new Set<string>();
    for (const commit_urn of commit_urns) {
      const edges = await this.deps.graph.listEdgesTo(commit_urn, predicate);
      for (const edge of edges) {
        const node = await this.deps.graph.getNode(edge.from_urn);
        if (node?.entity_type === entity_type) {
          collected.add(node.urn);
        }
      }
    }

    return await this.resolveSummaries([...collected]);
  }

  private async collectProtectedCommitOrigins(
    direct_commit_urns: string[],
    temporal?: TimeAwareTemporalQuery,
  ): Promise<Map<string, Set<string>>> {
    const origins = new Map<string, Set<string>>();
    for (const direct_commit_urn of direct_commit_urns) {
      const pending = [direct_commit_urn];
      const seen = new Set<string>();
      while (pending.length > 0) {
        const commit_urn = pending.shift();
        if (!commit_urn || seen.has(commit_urn)) continue;
        seen.add(commit_urn);

        const commit = await this.deps.graph.getNode(commit_urn);
        if (!commit || (temporal && !matchesTemporalQuery(commit, temporal))) continue;

        addOrigin(origins, commit_urn, direct_commit_urn);

        const parent_edges = await this.deps.graph.listEdgesFrom(commit_urn, 'sg:parentCommit');
        for (const edge of parent_edges) {
          pending.push(edge.to_urn);
        }
      }
    }

    return origins;
  }

  private async collectManifestCommitOrigins(commit_urns: string[]): Promise<Map<string, Set<string>>> {
    const origins = new Map<string, Set<string>>();
    for (const commit_urn of commit_urns) {
      const manifest_edges = await this.deps.graph.listEdgesFrom(commit_urn, 'sg:includesManifest');
      for (const edge of manifest_edges) {
        addOrigin(origins, edge.to_urn, commit_urn);
      }
    }
    return origins;
  }

  private async collectBlobManifestOrigins(manifest_urns: string[]): Promise<Map<string, Set<string>>> {
    const origins = new Map<string, Set<string>>();
    for (const manifest_urn of manifest_urns) {
      const blob_edges = await this.deps.graph.listEdgesFrom(manifest_urn, 'sg:containsBlob');
      for (const edge of blob_edges) {
        addOrigin(origins, edge.to_urn, manifest_urn);
      }
    }
    return origins;
  }

  private commitProtectionReasons(
    commit: TimeAwareSummary,
    direct_commits: TimeAwareSummary[],
    origins: Map<string, Set<string>>,
    retention_root_urn: string,
  ): TimeAwareGcPlanReason[] {
    if (direct_commits.some((direct) => direct.urn === commit.urn)) {
      return [
        {
          code: 'DIRECT_RETENTION_ROOT_COMMIT',
          detail: 'Commit is directly kept by the selected retention root.',
          related_urns: [retention_root_urn],
        },
      ];
    }

    return [
      {
        code: 'ANCESTOR_OF_RETAINED_COMMIT',
        detail: 'Commit stays protected because it is an ancestor of a directly retained commit.',
        related_urns: [...(origins.get(commit.urn) ?? [])].sort(),
      },
    ];
  }

  private manifestProtectionReasons(
    manifest: TimeAwareSummary,
    origins: Map<string, Set<string>>,
  ): TimeAwareGcPlanReason[] {
    return [
      {
        code: 'INCLUDED_BY_PROTECTED_COMMIT',
        detail: 'Manifest is included by at least one protected commit.',
        related_urns: [...(origins.get(manifest.urn) ?? [])].sort(),
      },
    ];
  }

  private blobProtectionReasons(
    blob: TimeAwareSummary,
    direct_blobs: TimeAwareSummary[],
    origins: Map<string, Set<string>>,
    retention_root_urn: string,
  ): TimeAwareGcPlanReason[] {
    const reasons: TimeAwareGcPlanReason[] = [];
    if (direct_blobs.some((direct) => direct.urn === blob.urn)) {
      reasons.push({
        code: 'DIRECT_RETENTION_ROOT_BLOB',
        detail: 'Blob is directly kept by the selected retention root.',
        related_urns: [retention_root_urn],
      });
    }
    if (origins.has(blob.urn)) {
      reasons.push({
        code: 'CONTAINED_BY_PROTECTED_MANIFEST',
        detail: 'Blob stays protected because it is contained by a protected manifest.',
        related_urns: [...(origins.get(blob.urn) ?? [])].sort(),
      });
    }
    return reasons.length > 0 ? reasons : [globalCandidateReason('blob', blob.urn)];
  }

  private pointerBlockers(
    blocker_kind: 'REF' | 'TAG' | 'WORKSPACE',
    pointers: TimeAwareSummary[],
  ): TimeAwareGcPlanBlocker[] {
    return pointers.map((pointer) => ({
      blocker_kind,
      blocker: pointer,
      reasons: [
        {
          code: `${blocker_kind}_POINTS_TO_PROTECTED_COMMIT`,
          detail: `${blocker_kind} still points at a protected commit in the selected retention scope.`,
          related_urns: [pointer.urn],
        },
      ],
    }));
  }

  private buildOtherRootBlockers(
    selected: TimeAwareRetentionRootAnalysis,
    all_analyses: TimeAwareRetentionRootAnalysis[],
  ): TimeAwareGcPlanBlocker[] {
    const selected_urn = selected.retention_root.urn;
    const selected_commit_urns = new Set(selected.reachable_commits.map((commit) => commit.urn));
    const selected_manifest_urns = new Set(selected.reachable_manifests.map((manifest) => manifest.urn));
    const selected_blob_urns = new Set(selected.reachable_blobs.map((blob) => blob.urn));

    const blockers: TimeAwareGcPlanBlocker[] = [];
    for (const analysis of all_analyses) {
      if (analysis.retention_root.urn === selected_urn) continue;
      const related_urns = [
        ...analysis.reachable_commits.filter((commit) => selected_commit_urns.has(commit.urn)).map((commit) => commit.urn),
        ...analysis.reachable_manifests
          .filter((manifest) => selected_manifest_urns.has(manifest.urn))
          .map((manifest) => manifest.urn),
        ...analysis.reachable_blobs.filter((blob) => selected_blob_urns.has(blob.urn)).map((blob) => blob.urn),
      ];
      if (related_urns.length === 0) continue;

      blockers.push({
        blocker_kind: 'RETENTION_ROOT',
        blocker: analysis.retention_root,
        reasons: [
          {
            code: 'ALSO_PROTECTED_BY_OTHER_RETENTION_ROOT',
            detail: 'Another retention root also protects part of this selected root closure.',
            related_urns: [...new Set(related_urns)].sort(),
          },
        ],
      });
    }

    return blockers;
  }

  private async resolveSummaries(urns: string[], temporal?: TimeAwareTemporalQuery): Promise<TimeAwareSummary[]> {
    const collected = new Map<string, TimeAwareSummary>();
    for (const urn of urns) {
      const node = await this.deps.graph.getNode(urn);
      if (node && (!temporal || matchesTemporalQuery(node, temporal))) {
        collected.set(node.urn, toSummary(node));
      }
    }
    return [...collected.values()].sort((a, b) => a.urn.localeCompare(b.urn));
  }
}

function decodeArtifactInput(content: string, encoding: 'utf8' | 'base64'): Uint8Array {
  return encoding === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8');
}

function listType(graph: GraphStore, entity_type: GraphNode['entity_type'], temporal?: TimeAwareTemporalQuery) {
  return graph
    .listNodesByType(entity_type)
    .then((nodes) => nodes.filter((node) => !temporal || matchesTemporalQuery(node, temporal)).map(toSummary));
}

function toSummary(node: GraphNode): TimeAwareSummary {
  return {
    urn: node.urn,
    properties: node.properties,
  };
}

function mapNode(node: GraphNode | null): TimeAwareSummary | null {
  return node ? toSummary(node) : null;
}

function requiredSummary(node: GraphNode | null, code: string): TimeAwareSummary {
  if (!node) throw new TimeAwareRegistryError(code, `Failed to create ${code}.`);
  return toSummary(node);
}

function sameProperties(a: Record<string, unknown>, b: Record<string, unknown>) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function matchesTemporalQuery(node: GraphNode, temporal?: TimeAwareTemporalQuery) {
  if (!temporal) return true;

  const valid_at = parseInstant(temporal.valid_at);
  if (valid_at !== null) {
    const valid_from = parseInstantProperty(node.properties['valid_from']);
    const valid_to = parseInstantProperty(node.properties['valid_to']);
    if (valid_from !== null && valid_at < valid_from) return false;
    if (valid_to !== null && valid_at >= valid_to) return false;
  }

  const transaction_as_of = parseInstant(temporal.transaction_as_of);
  if (transaction_as_of !== null) {
    const transaction_time = parseInstantProperty(node.properties['transaction_time']);
    if (transaction_time !== null && transaction_time > transaction_as_of) return false;
  }

  return true;
}

function sameValues(a: string[], b: string[]) {
  return JSON.stringify([...new Set(a)].sort()) === JSON.stringify([...new Set(b)].sort());
}

function dedupeSummaries(items: TimeAwareSummary[]) {
  const byUrn = new Map<string, TimeAwareSummary>();
  for (const item of items) {
    byUrn.set(item.urn, item);
  }
  return [...byUrn.values()].sort((left, right) => left.urn.localeCompare(right.urn));
}

function toPlanItem(object: TimeAwareSummary, reasons: TimeAwareGcPlanReason[]): TimeAwareGcPlanItem {
  return {
    object,
    reasons,
  };
}

function globalCandidateReason(kind: 'blob' | 'manifest', urn: string): TimeAwareGcPlanReason {
  const label = kind === 'blob' ? 'Blob' : 'Manifest';
  return {
    code: `UNPROTECTED_${kind.toUpperCase()}`,
    detail: `${label} is not protected by any retention root under the current query scope.`,
    related_urns: [urn],
  };
}

function addOrigin(map: Map<string, Set<string>>, key: string, origin: string) {
  const existing = map.get(key);
  if (existing) {
    existing.add(origin);
  } else {
    map.set(key, new Set([origin]));
  }
}

function compact<T>(items: Array<T | null>): T[] {
  return items.filter((item): item is T => item !== null);
}

function dedupeBlockers(items: TimeAwareGcPlanBlocker[]) {
  const byKey = new Map<string, TimeAwareGcPlanBlocker>();
  for (const item of items) {
    byKey.set(`${item.blocker_kind}:${item.blocker.urn}`, item);
  }
  return [...byKey.values()].sort((left, right) =>
    `${left.blocker_kind}:${left.blocker.urn}`.localeCompare(`${right.blocker_kind}:${right.blocker.urn}`),
  );
}

function nowIso() {
  return new Date().toISOString();
}

function parseInstant(value?: string) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function parseInstantProperty(value: unknown) {
  return typeof value === 'string' ? parseInstant(value) : null;
}
