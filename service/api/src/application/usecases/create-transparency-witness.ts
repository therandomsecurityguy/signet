import type { RegistryService } from '../../../../registry/application/ports/registry-service.js';
import type { CreateResult, RegistryTransparencyLogDetails } from '../../../../registry/application/ports/registry-service.js';

export class CreateTransparencyWitnessUseCase {
  constructor(private readonly registry: RegistryService) {}

  async execute(input: {
    log_id: string;
    witness_id: string;
    key_ref: string;
    witness_type?: string;
    valid_from?: string;
    valid_to?: string;
  }): Promise<CreateResult<RegistryTransparencyLogDetails>> {
    return await this.registry.createTransparencyWitness(input);
  }
}
