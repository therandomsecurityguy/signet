import type { TimeAwareRegistry } from '../../../../registry/application/time-aware/ports/time-aware-registry.js';
import type { CreateDraftWorkspaceFromRefInput } from '../../contracts/time-aware/workspaces.js';

export class TimeAwareRegistryUseCase {
  constructor(private readonly registry: TimeAwareRegistry) {}

  async getCommitDetails(input: { commit_urn: string; valid_at?: string | undefined; transaction_as_of?: string | undefined }) {
    return await this.registry.getCommitDetails(input);
  }

  async listCommits(input?: { valid_at?: string | undefined; transaction_as_of?: string | undefined }) {
    return await this.registry.listCommits(input);
  }

  async getRefDetails(input: { ref_urn: string }) {
    return await this.registry.getRefDetails(input);
  }

  async listRefs(input?: { commit_urn?: string | undefined; valid_at?: string | undefined; transaction_as_of?: string | undefined }) {
    return await this.registry.listRefs(input);
  }

  async getTagDetails(input: { tag_urn: string }) {
    return await this.registry.getTagDetails(input);
  }

  async listTags(input?: { commit_urn?: string | undefined; valid_at?: string | undefined; transaction_as_of?: string | undefined }) {
    return await this.registry.listTags(input);
  }

  async getWorkspaceDetails(input: { workspace_urn: string }) {
    return await this.registry.getWorkspaceDetails(input);
  }

  async listWorkspaces(
    input?: { base_commit_urn?: string | undefined; valid_at?: string | undefined; transaction_as_of?: string | undefined },
  ) {
    return await this.registry.listWorkspaces(input);
  }

  async listArtifactManifests() {
    return await this.registry.listArtifactManifests();
  }

  async listRetentionRoots() {
    return await this.registry.listRetentionRoots();
  }

  async analyzeRetentionRoot(
    input: { retention_root_urn: string; valid_at?: string | undefined; transaction_as_of?: string | undefined },
  ) {
    return await this.registry.analyzeRetentionRoot(input);
  }

  async previewGcPlan(
    input: { retention_root_urn: string; valid_at?: string | undefined; transaction_as_of?: string | undefined },
  ) {
    return await this.registry.previewGcPlan(input);
  }

  async listGcJobs() {
    return await this.registry.listGcJobs();
  }

  async createGcJob(input: { job_id: string; author: string; retention_root_urns: string[]; grace_period_days?: number }) {
    return await this.registry.createGcJob({
      job_id: input.job_id,
      author: input.author,
      retention_root_urns: input.retention_root_urns,
      ...(typeof input.grace_period_days === 'number' ? { grace_period_days: input.grace_period_days } : {}),
    });
  }

  async executeGcJob(input: { job_id: string; author: string }) {
    return await this.registry.executeGcJob(input);
  }

  async createDraftWorkspaceFromRef(input: { ref_name: string; workspace_id: string } & CreateDraftWorkspaceFromRefInput) {
    return await this.registry.createDraftWorkspaceFromRef({
      ref_name: input.ref_name,
      workspace_id: input.workspace_id,
      owner: input.owner,
      ...(input.expires_at ? { expires_at: input.expires_at } : {}),
      ...(input.promotion_path ? { promotion_path: input.promotion_path } : {}),
    });
  }
}
