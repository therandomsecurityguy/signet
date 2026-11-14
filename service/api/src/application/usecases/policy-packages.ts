import type { RegistryService } from '../../../../registry/application/ports/registry-service.js';
import type { CreatePolicyPackageInput } from '../../contracts/policy-packages.js';

export class PolicyPackageUseCase {
  constructor(private readonly registry: RegistryService) {}

  async create(input: CreatePolicyPackageInput) {
    return await this.registry.createPolicyPackage({
      policy_version: input.policy_version,
      author: input.author,
      shapes: input.shapes,
      ...(input.description ? { description: input.description } : {}),
    });
  }

  async list() {
    return await this.registry.listPolicyPackages();
  }

  async get(input: { policy_version: string }) {
    return await this.registry.getPolicyPackage(input);
  }
}
