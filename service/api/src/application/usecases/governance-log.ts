import type { RegistryService } from '../../../../registry/application/ports/registry-service.js';

export class GovernanceLogUseCase {
  constructor(private readonly registry: RegistryService) {}

  async getState() {
    return await this.registry.getGovernanceLogState();
  }

  async getProof(input: { leaf_index: number }) {
    return await this.registry.getGovernanceLogProof(input);
  }

  async replay() {
    return await this.registry.replayGovernanceLog();
  }

  async compareTransparency() {
    return await this.registry.compareGovernanceTransparencyLog();
  }

  async listEvents(input: {
    event_type?: string;
    publication_urn?: string;
    logical_key?: string;
    since?: string;
    until?: string;
    after_position?: number;
    limit?: number;
  }) {
    return await this.registry.getGovernanceEvents(input);
  }
}
