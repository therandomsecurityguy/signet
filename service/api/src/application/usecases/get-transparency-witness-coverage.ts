import type { RegistryService } from '../../../../registry/application/ports/registry-service.js';

export class GetTransparencyWitnessCoverageUseCase {
  constructor(private readonly registry: RegistryService) {}

  async execute(input?: { include_scoring?: boolean }) {
    return await this.registry.getTransparencyWitnessCoverage(input);
  }
}
