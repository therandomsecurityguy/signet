import type { RegistryService } from '../../../../registry/application/ports/registry-service.js';
import type { CreatePolicyPackageInput } from '../../contracts/policy-packages.js';

export class PolicyPackageUseCase {
  constructor(private readonly registry: RegistryService) {}

  async create(input: CreatePolicyPackageInput) {
    return await this.registry.createPolicyPackage({
      policy_version: input.policy_version,
      author: input.author,
      shapes: input.shapes,
      ...(input.shapes_format ? { shapes_format: input.shapes_format } : {}),
      ...(input.description ? { description: input.description } : {}),
      ...(input.require_human_review !== undefined ? { require_human_review: input.require_human_review } : {}),
      ...(input.require_validation !== undefined ? { require_validation: input.require_validation } : {}),
      ...(input.require_signature !== undefined ? { require_signature: input.require_signature } : {}),
      ...(input.require_trusted_publisher !== undefined
        ? { require_trusted_publisher: input.require_trusted_publisher }
        : {}),
      ...(input.require_build_provenance !== undefined
        ? { require_build_provenance: input.require_build_provenance }
        : {}),
      ...(input.require_sbom !== undefined ? { require_sbom: input.require_sbom } : {}),
    });
  }

  async list() {
    return await this.registry.listPolicyPackages();
  }

  async get(input: { policy_version: string }) {
    return await this.registry.getPolicyPackage(input);
  }

  async simulate(input: { policy_version: string; publication_urns: string[] }) {
    return await this.registry.simulatePolicyPackage(input);
  }
}
