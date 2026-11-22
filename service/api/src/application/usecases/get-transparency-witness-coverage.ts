import type { RegistryService } from '../../../../registry/application/ports/registry-service.js';

export class GetTransparencyWitnessCoverageUseCase {
  constructor(private readonly registry: RegistryService) {}

  async execute() {
    return await this.registry.getTransparencyWitnessCoverage();
  }
}
