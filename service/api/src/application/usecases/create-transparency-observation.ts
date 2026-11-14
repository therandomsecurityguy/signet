import type { RegistryService } from '../../../../registry/application/ports/registry-service.js';

export class CreateTransparencyObservationUseCase {
  constructor(private readonly registry: RegistryService) {}

  async execute(input: {
    log_id: string;
    checkpoint_body?: string;
    checkpoint_signature?: string;
    signed_note?: string;
    observed_from_type: 'log' | 'witness' | 'distributor' | 'peer';
    observed_from_id: string;
    observed_at?: string;
    source_channel?: string;
    observer_id?: string;
    observer_type?: string;
    relay_from_type?: 'log' | 'witness' | 'distributor' | 'peer';
    relay_from_id?: string;
    relay_hop_count?: number;
    source_checkpoint_occurred_at?: string;
  }) {
    return await this.registry.createTransparencyCheckpointObservation(input);
  }
}
