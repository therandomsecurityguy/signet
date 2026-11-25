import type {
  RegistrySearchResult,
} from '../../../../registry/application/ports/registry-service.js';

// Discovery search port. The graph adapter delegates to the registry core's
// searchRegistry (keyword/semantic modes, trust ranking, match components).
export interface RegistrySearchPort {
  search(input: {
    query: string;
    type: 'skill' | 'agent' | 'all';
    mode: 'keyword' | 'semantic';
    sort: 'default' | 'trust';
    limit?: number;
  }): Promise<RegistrySearchResult>;
}
