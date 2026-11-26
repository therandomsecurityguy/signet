export type EntityType =
  | 'AGENT'
  | 'AGENT_VERSION'
  | 'SKILL'
  | 'SKILL_VERSION'
  | 'TASK'
  | 'ARTIFACT'
  | 'ARTIFACT_BLOB'
  | 'ARTIFACT_MANIFEST'
  | 'COMMIT'
  | 'REF'
  | 'TAG'
  | 'WORKSPACE'
  | 'RETENTION_ROOT'
  | 'GC_JOB'
  | 'REVALIDATION_JOB'
  | 'USAGE_SIGNAL'
  | 'HARNESS'
  | 'TOOL'
  | 'PUBLIC_KEY'
  | 'PROV_AGENT'
  | 'GOVERNANCE_LOG'
  | 'DEFACTO_TERM'
  | 'TRANSPARENCY_LOG'
  | 'TRANSPARENCY_WITNESS'
  | 'TRANSPARENCY_GOSSIP_EVENT';

export type GraphNode = {
  urn: string;
  entity_type: EntityType;
  properties: Record<string, unknown>;
};

export type GraphEdge = {
  from_urn: string;
  to_urn: string;
  predicate: string;
  properties: Record<string, unknown>;
};

export type ListOptions = {
  limit?: number;
  offset?: number;
};

export interface GraphStore {
  upsertNode(node: GraphNode): Promise<void>;
  getNode(urn: string): Promise<GraphNode | null>;
  listNodesByType(entity_type: EntityType, opts?: ListOptions): Promise<GraphNode[]>;

  upsertEdge(edge: GraphEdge): Promise<void>;
  listEdgesFrom(from_urn: string, predicate?: string): Promise<GraphEdge[]>;
  listEdgesTo(to_urn: string, predicate?: string): Promise<GraphEdge[]>;
}

export class InMemoryGraphStore implements GraphStore {
  private readonly nodes = new Map<string, GraphNode>();
  private readonly edges = new Map<string, GraphEdge>();
  private readonly edgesByFrom = new Map<string, Set<string>>();
  private readonly edgesByTo = new Map<string, Set<string>>();

  async upsertNode(node: GraphNode): Promise<void> {
    this.nodes.set(node.urn, { ...node, properties: { ...node.properties } });
  }

  async getNode(urn: string): Promise<GraphNode | null> {
    const n = this.nodes.get(urn);
    return n ? { ...n, properties: { ...n.properties } } : null;
  }

  async listNodesByType(entity_type: EntityType, opts?: ListOptions): Promise<GraphNode[]> {
    const all = [...this.nodes.values()].filter((n) => n.entity_type === entity_type);
    const offset = opts?.offset ?? 0;
    const limit = opts?.limit ?? all.length;
    return all.slice(offset, offset + limit).map((n) => ({ ...n, properties: { ...n.properties } }));
  }

  async upsertEdge(edge: GraphEdge): Promise<void> {
    const key = edgeKey(edge);
    this.edges.set(key, { ...edge, properties: { ...edge.properties } });
    addIndex(this.edgesByFrom, edge.from_urn, key);
    addIndex(this.edgesByTo, edge.to_urn, key);
  }

  async listEdgesFrom(from_urn: string, predicate?: string): Promise<GraphEdge[]> {
    const keys = this.edgesByFrom.get(from_urn);
    if (!keys) return [];
    const out: GraphEdge[] = [];
    for (const k of keys) {
      const e = this.edges.get(k);
      if (!e) continue;
      if (predicate && e.predicate !== predicate) continue;
      out.push({ ...e, properties: { ...e.properties } });
    }
    return out;
  }

  async listEdgesTo(to_urn: string, predicate?: string): Promise<GraphEdge[]> {
    const keys = this.edgesByTo.get(to_urn);
    if (!keys) return [];
    const out: GraphEdge[] = [];
    for (const k of keys) {
      const e = this.edges.get(k);
      if (!e) continue;
      if (predicate && e.predicate !== predicate) continue;
      out.push({ ...e, properties: { ...e.properties } });
    }
    return out;
  }
}

function edgeKey(e: GraphEdge): string {
  return `${e.from_urn} ${e.predicate} ${e.to_urn}`;
}

function addIndex(map: Map<string, Set<string>>, k: string, edgeK: string) {
  const s = map.get(k);
  if (s) {
    s.add(edgeK);
  } else {
    map.set(k, new Set([edgeK]));
  }
}

