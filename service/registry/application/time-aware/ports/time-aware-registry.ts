export type CreateResult<T> = {
  value: T;
  created: boolean;
};

export type TimeAwareSummary = {
  urn: string;
  properties: Record<string, unknown>;
};

export type TimeAwareTemporalQuery = {
  valid_at?: string | undefined;
  transaction_as_of?: string | undefined;
};

export type TimeAwareCommitDetails = {
  commit: TimeAwareSummary;
  parent_commits: TimeAwareSummary[];
  child_commits: TimeAwareSummary[];
  manifests: TimeAwareSummary[];
  blobs: TimeAwareSummary[];
  refs: TimeAwareSummary[];
  tags: TimeAwareSummary[];
  workspaces: TimeAwareSummary[];
};

export type TimeAwareRefDetails = {
  ref: TimeAwareSummary;
  target_commit: TimeAwareSummary | null;
  target_commit_parents: TimeAwareSummary[];
};

export type TimeAwareTagDetails = {
  tag: TimeAwareSummary;
  target_commit: TimeAwareSummary | null;
  target_commit_parents: TimeAwareSummary[];
};

export type TimeAwareWorkspaceDetails = {
  workspace: TimeAwareSummary;
  base_commit: TimeAwareSummary | null;
  base_commit_parents: TimeAwareSummary[];
};

export type TimeAwareRetentionRootAnalysis = {
  retention_root: TimeAwareSummary;
  direct_commits: TimeAwareSummary[];
  reachable_commits: TimeAwareSummary[];
  reachable_manifests: TimeAwareSummary[];
  direct_blobs: TimeAwareSummary[];
  reachable_blobs: TimeAwareSummary[];
  refs: TimeAwareSummary[];
  tags: TimeAwareSummary[];
  workspaces: TimeAwareSummary[];
};

export type TimeAwareGcPlanReason = {
  code: string;
  detail: string;
  related_urns: string[];
};

export type TimeAwareGcPlanItem = {
  object: TimeAwareSummary;
  reasons: TimeAwareGcPlanReason[];
};

export type TimeAwareGcPlanBlocker = {
  blocker_kind: 'REF' | 'TAG' | 'WORKSPACE' | 'RETENTION_ROOT';
  blocker: TimeAwareSummary;
  reasons: TimeAwareGcPlanReason[];
};

export type TimeAwareGcPlanPreview = {
  retention_root: TimeAwareSummary;
  protected_commits: TimeAwareGcPlanItem[];
  protected_manifests: TimeAwareGcPlanItem[];
  protected_blobs: TimeAwareGcPlanItem[];
  candidate_manifests: TimeAwareGcPlanItem[];
  candidate_blobs: TimeAwareGcPlanItem[];
  blockers: TimeAwareGcPlanBlocker[];
};

export type TimeAwareArtifactBlobInput = {
  content: string;
  encoding: 'utf8' | 'base64';
  media_type?: string;
  original_path?: string;
};

export type TimeAwareCommitInput = {
  commit_id: string;
  author: string;
  message: string;
  parent_commit_urns?: string[];
  manifest_urns?: string[];
  ontology_version?: string;
  validation_rules_version?: string;
  transaction_time?: string;
  valid_from?: string;
  valid_to?: string;
};

export type TimeAwareRefInput = {
  ref_name: string;
  commit_urn: string;
  author: string;
};

export type TimeAwareTagInput = {
  tag_name: string;
  commit_urn: string;
  author: string;
  immutable_reason?: string;
};

export type TimeAwareWorkspaceInput = {
  workspace_id: string;
  base_commit_urn: string;
  owner: string;
  expires_at?: string;
  promotion_path?: string;
};

export type TimeAwareManifestInput = {
  manifest_id: string;
  author: string;
  artifact_blobs: TimeAwareArtifactBlobInput[];
};

export type TimeAwareRetentionRootInput = {
  root_id: string;
  root_kind: string;
  description?: string;
  commit_urns?: string[];
  blob_urns?: string[];
};

export type TimeAwareGcJobInput = {
  job_id: string;
  author: string;
  retention_root_urns: string[];
  grace_period_days?: number;
};

export type DraftWorkspaceFromRefInput = {
  workspace_id: string;
  ref_name: string;
  owner: string;
  expires_at?: string;
  promotion_path?: string;
};

export interface TimeAwareRegistry {
  createCommit(input: TimeAwareCommitInput): Promise<CreateResult<TimeAwareSummary>>;
  getCommit(input: { commit_urn: string }): Promise<TimeAwareSummary | null>;
  getCommitDetails(input: { commit_urn: string } & TimeAwareTemporalQuery): Promise<TimeAwareCommitDetails | null>;
  listCommits(input?: TimeAwareTemporalQuery): Promise<{ commits: TimeAwareSummary[] }>;

  createRef(input: TimeAwareRefInput): Promise<CreateResult<TimeAwareSummary>>;
  getRef(input: { ref_urn: string }): Promise<TimeAwareSummary | null>;
  getRefDetails(input: { ref_urn: string }): Promise<TimeAwareRefDetails | null>;
  listRefs(input?: { commit_urn?: string | undefined } & TimeAwareTemporalQuery): Promise<{ refs: TimeAwareSummary[] }>;

  createTag(input: TimeAwareTagInput): Promise<CreateResult<TimeAwareSummary>>;
  getTag(input: { tag_urn: string }): Promise<TimeAwareSummary | null>;
  getTagDetails(input: { tag_urn: string }): Promise<TimeAwareTagDetails | null>;
  listTags(input?: { commit_urn?: string | undefined } & TimeAwareTemporalQuery): Promise<{ tags: TimeAwareSummary[] }>;

  createWorkspace(input: TimeAwareWorkspaceInput): Promise<CreateResult<TimeAwareSummary>>;
  getWorkspace(input: { workspace_urn: string }): Promise<TimeAwareSummary | null>;
  getWorkspaceDetails(input: { workspace_urn: string }): Promise<TimeAwareWorkspaceDetails | null>;
  listWorkspaces(
    input?: { base_commit_urn?: string | undefined } & TimeAwareTemporalQuery,
  ): Promise<{ workspaces: TimeAwareSummary[] }>;
  createDraftWorkspaceFromRef(input: DraftWorkspaceFromRefInput): Promise<CreateResult<TimeAwareSummary>>;

  createArtifactManifest(input: TimeAwareManifestInput): Promise<CreateResult<TimeAwareSummary>>;
  getArtifactManifest(input: { manifest_urn: string }): Promise<TimeAwareSummary | null>;
  listArtifactManifests(): Promise<{ manifests: TimeAwareSummary[] }>;

  createRetentionRoot(input: TimeAwareRetentionRootInput): Promise<CreateResult<TimeAwareSummary>>;
  getRetentionRoot(input: { retention_root_urn: string }): Promise<TimeAwareSummary | null>;
  analyzeRetentionRoot(input: { retention_root_urn: string } & TimeAwareTemporalQuery): Promise<TimeAwareRetentionRootAnalysis | null>;
  previewGcPlan(input: { retention_root_urn: string } & TimeAwareTemporalQuery): Promise<TimeAwareGcPlanPreview | null>;
  listRetentionRoots(): Promise<{ retention_roots: TimeAwareSummary[] }>;

  createGcJob(input: TimeAwareGcJobInput): Promise<CreateResult<TimeAwareSummary>>;
  getGcJob(input: { gc_job_urn: string }): Promise<TimeAwareSummary | null>;
  listGcJobs(): Promise<{ gc_jobs: TimeAwareSummary[] }>;
  executeGcJob(input: { job_id: string; author: string }): Promise<TimeAwareSummary>;
}
