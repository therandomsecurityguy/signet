import type { RegistryService } from '../../../../registry/application/ports/registry-service.js';
import type { CreateResult } from '../ports/skill-registry.js';
import type { RegistryTransparencyLogDetails } from '../../../../registry/application/ports/registry-service.js';

export class CreateTransparencyLogUseCase {
  constructor(private readonly registry: RegistryService) {}

  async execute(input: {
    log_id: string;
    origin: string;
    checkpoint_key_ref: string;
    log_type?: string;
    trust_scope?: string;
    valid_from?: string;
    valid_to?: string;
    witness_quorum?: number;
  }): Promise<CreateResult<RegistryTransparencyLogDetails>> {
    return await this.registry.createTransparencyLog(input);
  }
}
