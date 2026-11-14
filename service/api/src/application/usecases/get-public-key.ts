import type { RegistryService } from '../../../../registry/application/ports/registry-service.js';

export class GetPublicKeyUseCase {
  constructor(private readonly registry: RegistryService) {}

  async execute(input: { key_ref: string }) {
    return await this.registry.getTrustedPublicKey(input);
  }
}
