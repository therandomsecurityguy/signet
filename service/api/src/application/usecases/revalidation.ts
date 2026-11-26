import type { RegistryRecertificationQueue, RegistryRevalidationJobSummary } from '../../../../registry/application/ports/registry-service.js';
import type { RegistryService } from '../../../../registry/application/ports/registry-service.js';

export class RevalidationUseCase {
  constructor(private readonly registry: RegistryService) {}

  async getQueue(input: {
    state?: 'due' | 'approaching' | 'all';
    entity_type?: 'skill' | 'agent' | 'all';
    limit?: number;
    offset?: number;
  }): Promise<RegistryRecertificationQueue> {
    return await this.registry.getRecertificationQueue(input);
  }

  async createJob(input: {
    job_id: string;
    author: string;
    scope?: 'due' | 'approaching' | 'all';
    entity_type?: 'skill' | 'agent' | 'all';
    limit?: number;
  }): Promise<{ value: RegistryRevalidationJobSummary; created: boolean }> {
    return await this.registry.createRevalidationJob(input);
  }

  async executeJob(input: { job_id: string; author: string }): Promise<RegistryRevalidationJobSummary> {
    return await this.registry.executeRevalidationJob(input);
  }

  async getJob(input: { job_id: string }): Promise<RegistryRevalidationJobSummary | null> {
    return await this.registry.getRevalidationJob(input);
  }

  async listJobs(input?: { limit?: number; offset?: number }): Promise<{ jobs: RegistryRevalidationJobSummary[] }> {
    return await this.registry.listRevalidationJobs(input);
  }
}
