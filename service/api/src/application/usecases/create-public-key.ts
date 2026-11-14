import type { CreateTrustedPublicKeyInput, CreateTrustedPublicKeyOutput } from '../../contracts/public-keys/create-public-key.js';
import type { RegistryService } from '../../../../registry/application/ports/registry-service.js';
import type { CreateResult } from '../ports/skill-registry.js';

export class CreatePublicKeyUseCase {
  constructor(private readonly registry: RegistryService) {}

  async execute(input: CreateTrustedPublicKeyInput): Promise<CreateResult<CreateTrustedPublicKeyOutput>> {
    return await this.registry.createTrustedPublicKey({
      key_ref: input.key_ref,
      algorithm: input.algorithm,
      public_key_pem: input.public_key_pem,
      ...(input.owner ? { owner: input.owner } : {}),
      ...(input.trust_scope ? { trust_scope: input.trust_scope } : {}),
      ...(input.valid_from ? { valid_from: input.valid_from } : {}),
      ...(input.valid_to ? { valid_to: input.valid_to } : {}),
      ...(input.transparency_log_ref ? { transparency_log_ref: input.transparency_log_ref } : {}),
      ...(input.inclusion_proof_ref ? { inclusion_proof_ref: input.inclusion_proof_ref } : {}),
      ...(input.supersedes_key_ref ? { supersedes_key_ref: input.supersedes_key_ref } : {}),
    });
  }
}
