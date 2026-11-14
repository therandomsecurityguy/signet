import type { RegistryService } from '../../../../registry/application/ports/registry-service.js';

export class ReviewsUseCase {
  constructor(private readonly registry: RegistryService) {}

  async listPending() {
    return await this.registry.listPendingReviews();
  }
}
