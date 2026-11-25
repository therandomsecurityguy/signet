import type { RegistryTagsPort } from '../ports/registry-tags.js';

export class SetTagsUseCase {
  constructor(private readonly registry: RegistryTagsPort) {}

  async execute(input: {
    entity_type: 'SKILL' | 'AGENT';
    logical_key: string;
    tags: string[];
  }): Promise<{ tags: string[] }> {
    return await this.registry.setTags(input);
  }
}
