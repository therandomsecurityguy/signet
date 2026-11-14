import type { RegistryService } from '../../../../registry/application/ports/registry-service.js';

export class GetTransparencyLogVerificationUseCase {
  constructor(private readonly registry: RegistryService) {}

  async execute(input: { log_id: string }) {
    return await this.registry.getTransparencyLogVerification(input);
  }
}
