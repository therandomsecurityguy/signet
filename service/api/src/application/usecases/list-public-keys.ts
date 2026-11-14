import type { RegistryService } from '../../../../registry/application/ports/registry-service.js';

export class ListPublicKeysUseCase {
  constructor(private readonly registry: RegistryService) {}

  async execute(input: { limit?: number; offset?: number }) {
    return await this.registry.listTrustedPublicKeys(input);
  }
}
