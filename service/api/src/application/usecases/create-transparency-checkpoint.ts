import type { RegistryService } from '../../../../registry/application/ports/registry-service.js';

export class CreateTransparencyCheckpointUseCase {
  constructor(private readonly registry: RegistryService) {}

  async execute(input: {
    log_id: string;
    checkpoint_body?: string;
    checkpoint_signature?: string;
    signed_note?: string;
    consistency_proof?: {
      previous_tree_size: number;
      previous_root_hash: string;
      proof_hashes: string[];
    };
    witness_attestations?: Array<{
      witness_id: string;
      signature: string;
    }>;
    transparency_log_ref?: string;
  }) {
    return await this.registry.createTransparencyCheckpoint(input);
  }
}
