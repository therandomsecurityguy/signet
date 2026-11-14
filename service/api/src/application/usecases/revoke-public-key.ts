import type { RegistryService } from '../../../../registry/application/ports/registry-service.js';

export class RevokePublicKeyUseCase {
  constructor(private readonly registry: RegistryService) {}

  async execute(input: { key_ref: string; author: string; reason?: string }) {
    return await this.registry.revokeTrustedPublicKey(input);
  }
}
