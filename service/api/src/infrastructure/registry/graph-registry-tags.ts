import type { RegistryTagsPort } from '../../application/ports/registry-tags.js';
import { ApiError } from '../../domain/errors/api-error.js';
import { RegistryCoreError } from '../../../../registry/application/errors/registry-core-error.js';
import type { RegistryService } from '../../../../registry/application/ports/registry-service.js';

export class GraphRegistryTags implements RegistryTagsPort {
  constructor(private readonly service: RegistryService) {}

  async setTags(input: {
    entity_type: 'SKILL' | 'AGENT';
    logical_key: string;
    tags: string[];
  }): Promise<{ tags: string[] }> {
    try {
      return await this.service.updateTags(input);
    } catch (err) {
      if (err instanceof RegistryCoreError) {
        switch (err.code) {
          case 'TAG_INVALID':
          case 'TAG_LIMIT_EXCEEDED':
            throw new ApiError(err.code, 400, err.message);
          case 'SKILL_NOT_FOUND':
          case 'AGENT_NOT_FOUND':
            throw new ApiError(err.code, 404, err.message);
          default:
            throw new ApiError(err.code, 500, err.message);
        }
      }
      if (err instanceof ApiError) throw err;
      throw new ApiError('INTERNAL_ERROR', 500, 'Internal error.');
    }
  }
}
