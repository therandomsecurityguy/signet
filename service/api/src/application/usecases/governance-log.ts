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
}
