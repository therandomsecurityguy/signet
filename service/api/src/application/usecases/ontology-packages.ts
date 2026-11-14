import type { RegistryService } from '../../../../registry/application/ports/registry-service.js';
import type { CreateOntologyPackageInput } from '../../contracts/ontology-packages.js';

export class OntologyPackageUseCase {
  constructor(private readonly registry: RegistryService) {}

  async create(input: CreateOntologyPackageInput) {
    return await this.registry.createOntologyPackage({
      ontology_version: input.ontology_version,
      author: input.author,
      ontology: input.ontology,
      ...(input.description ? { description: input.description } : {}),
    });
  }

  async list() {
    return await this.registry.listOntologyPackages();
  }

  async get(input: { ontology_version: string }) {
    return await this.registry.getOntologyPackage(input);
  }
}
