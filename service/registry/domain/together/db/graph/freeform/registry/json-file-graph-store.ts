import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import type { GraphEdge, GraphNode, GraphStore, ListOptions } from './graph-store.js';

type GraphState = {
  nodes: GraphNode[];
  edges: GraphEdge[];
};

const EMPTY_STATE: GraphState = {
  nodes: [],
  edges: [],
};

export type JsonFileGraphStoreConfig = {
  state_file: string;
};

export class JsonFileGraphStore implements GraphStore {
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly cfg: JsonFileGraphStoreConfig) {}

  async upsertNode(node: GraphNode): Promise<void> {
    await this.withWriteLock(async () => {
      const state = await this.readState();
      const idx = state.nodes.findIndex((n) => n.urn === node.urn);
      const normalized = cloneNode(node);
      if (idx >= 0) {
        state.nodes[idx] = normalized;
      } else {
        state.nodes.push(normalized);
      }
      await this.writeState(state);
    });
  }

  async getNode(urn: string): Promise<GraphNode | null> {
    const state = await this.readState();
    const node = state.nodes.find((n) => n.urn === urn);
    return node ? cloneNode(node) : null;
  }

  async listNodesByType(entity_type: GraphNode['entity_type'], opts?: ListOptions): Promise<GraphNode[]> {
    const state = await this.readState();
    const all = state.nodes.filter((n) => n.entity_type === entity_type);
    const offset = opts?.offset ?? 0;
    const limit = opts?.limit ?? all.length;
    return all.slice(offset, offset + limit).map(cloneNode);
  }

  async upsertEdge(edge: GraphEdge): Promise<void> {
    await this.withWriteLock(async () => {
      const state = await this.readState();
      const key = edgeKey(edge);
      const idx = state.edges.findIndex((e) => edgeKey(e) === key);
      const normalized = cloneEdge(edge);
      if (idx >= 0) {
        state.edges[idx] = normalized;
      } else {
        state.edges.push(normalized);
      }
      await this.writeState(state);
    });
  }

  async listEdgesFrom(from_urn: string, predicate?: string): Promise<GraphEdge[]> {
    const state = await this.readState();
    return state.edges
      .filter((e) => e.from_urn === from_urn && (!predicate || e.predicate === predicate))
      .map(cloneEdge);
  }

  async listEdgesTo(to_urn: string, predicate?: string): Promise<GraphEdge[]> {
    const state = await this.readState();
    return state.edges
      .filter((e) => e.to_urn === to_urn && (!predicate || e.predicate === predicate))
      .map(cloneEdge);
  }

  private async withWriteLock(fn: () => Promise<void>) {
    this.writeChain = this.writeChain.then(fn, fn);
    await this.writeChain;
  }

  private async readState(): Promise<GraphState> {
    try {
      const raw = await readFile(this.cfg.state_file, 'utf8');
      const parsed = JSON.parse(raw) as Partial<GraphState>;
      return {
        nodes: Array.isArray(parsed.nodes) ? parsed.nodes.map(cloneNode) : [],
        edges: Array.isArray(parsed.edges) ? parsed.edges.map(cloneEdge) : [],
      };
    } catch {
      return cloneState(EMPTY_STATE);
    }
  }

  private async writeState(state: GraphState): Promise<void> {
    const dir = path.dirname(this.cfg.state_file);
    await mkdir(dir, { recursive: true });
    const tmp = `${this.cfg.state_file}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
    await rename(tmp, this.cfg.state_file);
  }
}

function edgeKey(e: GraphEdge): string {
  return `${e.from_urn} ${e.predicate} ${e.to_urn}`;
}

function cloneNode(node: GraphNode): GraphNode {
  return {
    urn: node.urn,
    entity_type: node.entity_type,
    properties: { ...node.properties },
  };
}

function cloneEdge(edge: GraphEdge): GraphEdge {
  return {
    from_urn: edge.from_urn,
    to_urn: edge.to_urn,
    predicate: edge.predicate,
    properties: { ...edge.properties },
  };
}

function cloneState(state: GraphState): GraphState {
  return {
    nodes: state.nodes.map(cloneNode),
    edges: state.edges.map(cloneEdge),
  };
}
