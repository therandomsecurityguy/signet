import type { RegistryService } from '../../../../registry/application/ports/registry-service.js';

export class ReconcilePublicationTransparencyUseCase {
  constructor(private readonly registry: RegistryService) {}

  async execute(input: { publication_urn: string }) {
    return await this.registry.reconcilePublicationTransparency(input);
  }
}
