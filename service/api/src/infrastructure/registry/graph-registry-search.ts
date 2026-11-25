import type { RegistrySearchPort } from '../../application/ports/registry-search.js';
import { ApiError } from '../../domain/errors/api-error.js';
import { RegistryCoreError } from '../../../../registry/application/errors/registry-core-error.js';
import type { RegistryService } from '../../../../registry/application/ports/registry-service.js';

export class GraphRegistrySearch implements RegistrySearchPort {
  constructor(private readonly service: RegistryService) {}

  async search(input: {
    query: string;
    type: 'skill' | 'agent' | 'all';
    mode: 'keyword' | 'semantic';
    sort: 'default' | 'trust';
    limit?: number;
  }) {
    try {
      return await this.service.searchRegistry(input);
    } catch (err) {
      if (err instanceof RegistryCoreError) {
        throw new ApiError(err.code, 500, err.message);
      }
      if (err instanceof ApiError) throw err;
      throw new ApiError('INTERNAL_ERROR', 500, 'Internal error.');
    }
  }
}
