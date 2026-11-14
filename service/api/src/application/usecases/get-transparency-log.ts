import type { RegistryService } from '../../../../registry/application/ports/registry-service.js';

export class GetTransparencyLogUseCase {
  constructor(private readonly registry: RegistryService) {}

  async execute(input: { log_id: string }) {
    return await this.registry.getTransparencyLog(input);
  }
}
