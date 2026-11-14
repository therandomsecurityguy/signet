import type { RegistryService } from '../../../../registry/application/ports/registry-service.js';

export class CreateTransparencyGossipEventUseCase {
  constructor(private readonly registry: RegistryService) {}

  async execute(input: {
    log_id: string;
    from_witness_id: string;
    to_witness_id: string;
    checkpoint_artifact_urn: string;
    occurred_at?: string;
    source_channel?: string;
    relayed_by_id?: string;
    relay_hop_count?: number;
    source_checkpoint_occurred_at?: string;
  }) {
    return await this.registry.createTransparencyGossipEvent(input);
  }
}
