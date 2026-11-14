import type { RegistryService } from '../../../../registry/application/ports/registry-service.js';

export class GetTransparencyLogTimelineUseCase {
  constructor(private readonly registry: RegistryService) {}

  async execute(input: { log_id: string }) {
    return await this.registry.getTransparencyLogTimeline(input);
  }
}
