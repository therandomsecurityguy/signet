import * as path from 'node:path';

import { InMemoryGraphStore } from '../../../../registry/domain/signet/db/graph/freeform/registry/graph-store.js';
import type { GraphStore } from '../../../../registry/domain/signet/db/graph/freeform/registry/graph-store.js';
import { JsonFileGraphStore } from '../../../../registry/domain/signet/db/graph/freeform/registry/json-file-graph-store.js';
import { SparqlGraphStore } from '../../../../registry/domain/signet/db/graph/freeform/registry/sparql-graph-store.js';

export function buildGraphStore(input: {
  backend: 'json_file' | 'memory' | 'sparql';
  state_file?: string;
  sparql_query_url?: string;
  sparql_update_url?: string;
  sparql_username?: string;
  sparql_password?: string;
}): GraphStore {
  switch (input.backend) {
    case 'memory':
      return new InMemoryGraphStore();
    case 'sparql':
      if (!input.sparql_query_url) {
        throw new Error('sparql_query_url is required when backend=sparql');
      }
      return new SparqlGraphStore({
        query_url: input.sparql_query_url,
        ...(input.sparql_update_url ? { update_url: input.sparql_update_url } : {}),
        ...(input.sparql_username ? { username: input.sparql_username } : {}),
        ...(input.sparql_password ? { password: input.sparql_password } : {}),
      });
    case 'json_file':
    default:
      if (!input.state_file) {
        throw new Error('state_file is required when backend=json_file');
      }
      return new JsonFileGraphStore({
        state_file: path.resolve(input.state_file),
      });
  }
}
