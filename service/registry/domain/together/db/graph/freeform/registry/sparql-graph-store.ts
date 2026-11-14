import type { GraphEdge, GraphNode, GraphStore, ListOptions } from './graph-store.js';

export type SparqlGraphStoreConfig = {
  query_url: string;
  update_url?: string;
  username?: string;
  password?: string;
};

export class SparqlGraphStore implements GraphStore {
  constructor(private readonly cfg: SparqlGraphStoreConfig) {}

  async upsertNode(node: GraphNode): Promise<void> {
    const query = `
DELETE {
  ${iri(node.urn)} ?p ?o .
}
WHERE {
  OPTIONAL { ${iri(node.urn)} ?p ?o . }
};
INSERT DATA {
  ${iri(node.urn)} ${iri(PREDICATES.entityType)} ${literal(node.entity_type)} .
  ${iri(node.urn)} ${iri(PREDICATES.properties)} ${literal(JSON.stringify(node.properties))} .
}
`;
    await this.executeUpdate(query);
  }

  async getNode(urn: string): Promise<GraphNode | null> {
    const query = `
SELECT ?entity_type ?properties
WHERE {
  ${iri(urn)} ${iri(PREDICATES.entityType)} ?entity_type ;
             ${iri(PREDICATES.properties)} ?properties .
}
LIMIT 1
`;
    const rows = await this.executeSelect(query);
    const row = rows[0];
    if (!row) return null;
    const entityType = row['entity_type'];
    const properties = row['properties'];
    if (!entityType || !properties) return null;
    return {
      urn,
      entity_type: entityType as GraphNode['entity_type'],
      properties: parseProperties(properties),
    };
  }

  async listNodesByType(entity_type: GraphNode['entity_type'], opts?: ListOptions): Promise<GraphNode[]> {
    const offset = opts?.offset ?? 0;
    const limitClause = typeof opts?.limit === 'number' ? `LIMIT ${opts.limit}` : '';
    const offsetClause = offset > 0 ? `OFFSET ${offset}` : '';
    const query = `
SELECT ?urn ?properties
WHERE {
  ?urn ${iri(PREDICATES.entityType)} ${literal(entity_type)} ;
       ${iri(PREDICATES.properties)} ?properties .
}
ORDER BY STR(?urn)
${limitClause}
${offsetClause}
`;
    const rows = await this.executeSelect(query);
    return rows
      .filter((row) => row['urn'] && row['properties'])
      .map((row) => ({
        urn: String(row['urn']),
        entity_type,
        properties: parseProperties(String(row['properties'])),
      }));
  }

  async upsertEdge(edge: GraphEdge): Promise<void> {
    const edgeIri = edgeIriFor(edge);
    const query = `
DELETE {
  ${iri(edgeIri)} ?p ?o .
}
WHERE {
  OPTIONAL { ${iri(edgeIri)} ?p ?o . }
};
INSERT DATA {
  ${iri(edgeIri)} ${iri(PREDICATES.edgeFrom)} ${iri(edge.from_urn)} .
  ${iri(edgeIri)} ${iri(PREDICATES.edgeTo)} ${iri(edge.to_urn)} .
  ${iri(edgeIri)} ${iri(PREDICATES.edgePredicate)} ${literal(edge.predicate)} .
  ${iri(edgeIri)} ${iri(PREDICATES.properties)} ${literal(JSON.stringify(edge.properties))} .
}
`;
    await this.executeUpdate(query);
  }

  async listEdgesFrom(from_urn: string, predicate?: string): Promise<GraphEdge[]> {
    const predicateFilter = predicate ? `FILTER (?predicate = ${literal(predicate)})` : '';
    const query = `
SELECT ?to_urn ?predicate ?properties
WHERE {
  ?edge ${iri(PREDICATES.edgeFrom)} ${iri(from_urn)} ;
        ${iri(PREDICATES.edgeTo)} ?to_urn ;
        ${iri(PREDICATES.edgePredicate)} ?predicate ;
        ${iri(PREDICATES.properties)} ?properties .
  ${predicateFilter}
}
ORDER BY STR(?to_urn)
`;
    const rows = await this.executeSelect(query);
    return rows
      .filter((row) => row['to_urn'] && row['predicate'] && row['properties'])
      .map((row) => ({
        from_urn,
        to_urn: String(row['to_urn']),
        predicate: String(row['predicate']),
        properties: parseProperties(String(row['properties'])),
      }));
  }

  async listEdgesTo(to_urn: string, predicate?: string): Promise<GraphEdge[]> {
    const predicateFilter = predicate ? `FILTER (?predicate = ${literal(predicate)})` : '';
    const query = `
SELECT ?from_urn ?predicate ?properties
WHERE {
  ?edge ${iri(PREDICATES.edgeFrom)} ?from_urn ;
        ${iri(PREDICATES.edgeTo)} ${iri(to_urn)} ;
        ${iri(PREDICATES.edgePredicate)} ?predicate ;
        ${iri(PREDICATES.properties)} ?properties .
  ${predicateFilter}
}
ORDER BY STR(?from_urn)
`;
    const rows = await this.executeSelect(query);
    return rows
      .filter((row) => row['from_urn'] && row['predicate'] && row['properties'])
      .map((row) => ({
        from_urn: String(row['from_urn']),
        to_urn,
        predicate: String(row['predicate']),
        properties: parseProperties(String(row['properties'])),
      }));
  }

  private async executeSelect(query: string): Promise<Array<Record<string, string>>> {
    const res = await fetch(this.cfg.query_url, {
      method: 'POST',
      headers: {
        'content-type': 'application/sparql-query',
        accept: 'application/sparql-results+json',
        ...authHeaders(this.cfg),
      },
      body: query,
    });
    if (!res.ok) {
      throw new Error(`SparqlGraphStore query failed (${res.status})`);
    }

    const body = (await res.json()) as {
      results?: { bindings?: Array<Record<string, { value: string }>> };
    };
    const bindings = body.results?.bindings ?? [];
    return bindings.map((binding) =>
      Object.fromEntries(Object.entries(binding).map(([k, v]) => [k, v.value])),
    );
  }

  private async executeUpdate(query: string): Promise<void> {
    const res = await fetch(resolveUpdateUrl(this.cfg), {
      method: 'POST',
      headers: {
        'content-type': 'application/sparql-update',
        ...authHeaders(this.cfg),
      },
      body: query,
    });
    if (!res.ok) {
      throw new Error(`SparqlGraphStore update failed (${res.status})`);
    }
  }
}

const PREDICATES = {
  entityType: 'urn:sg:meta:entityType',
  properties: 'urn:sg:meta:properties',
  edgeFrom: 'urn:sg:meta:from',
  edgeTo: 'urn:sg:meta:to',
  edgePredicate: 'urn:sg:meta:predicate',
} as const;

// IRIs are composed from registry URNs, which embed entity keys and other
// registry inputs. A value containing IRI metacharacters (`>`, quotes,
// whitespace, braces, pipes, backslashes, carets, backticks) would break out
// of <...> and inject SPARQL, so composition fails closed instead.
export const IRI_UNSAFE_PATTERN = /[^A-Za-z0-9:._~@/%#-]/;

export function iri(value: string) {
  if (value.length === 0 || IRI_UNSAFE_PATTERN.test(value)) {
    throw new Error(
      `Refusing to compose a SPARQL IRI from an unsafe value (first 80 chars): ${value.slice(0, 80)}`,
    );
  }
  return `<${value}>`;
}

// JSON.stringify escapes quotes, backslashes, and all control characters,
// which matches what a double-quoted SPARQL literal needs — safe as-is.
function literal(value: string) {
  return JSON.stringify(value);
}

function parseProperties(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function edgeIriFor(edge: GraphEdge) {
  const encoded = Buffer.from(`${edge.from_urn}|${edge.predicate}|${edge.to_urn}`, 'utf8').toString('base64url');
  return `urn:sg:edge:${encoded}`;
}

function resolveUpdateUrl(cfg: SparqlGraphStoreConfig) {
  if (cfg.update_url) return cfg.update_url;
  return cfg.query_url.endsWith('/sparql') ? `${cfg.query_url.slice(0, -'/sparql'.length)}/update` : cfg.query_url;
}

function authHeaders(cfg: SparqlGraphStoreConfig) {
  if (!cfg.username || !cfg.password) return {};
  const token = Buffer.from(`${cfg.username}:${cfg.password}`, 'utf8').toString('base64');
  return { authorization: `Basic ${token}` };
}

