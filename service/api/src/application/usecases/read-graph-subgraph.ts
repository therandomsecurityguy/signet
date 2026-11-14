import type { GraphStore } from '../../../../registry/domain/signet/db/graph/freeform/registry/graph-store.js';
import type { GraphSubgraphInput, GraphSubgraphOutput } from '../../contracts/graph/subgraph.js';

export class ReadGraphSubgraphUseCase {
  constructor(private readonly graph: GraphStore) {}

  async execute(input: GraphSubgraphInput): Promise<GraphSubgraphOutput | null> {
    const root = await this.graph.getNode(input.root_urn);
    if (!root) {
      return null;
    }

    const nodes = new Map<string, GraphSubgraphOutput['nodes'][number]>();
    const edges = new Map<string, GraphSubgraphOutput['edges'][number]>();
    const queue: Array<{ urn: string; depth: number }> = [{ urn: input.root_urn, depth: 0 }];
    const seenDepth = new Map<string, number>();

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) continue;

      const previousDepth = seenDepth.get(current.urn);
      if (previousDepth !== undefined && previousDepth <= current.depth) {
        continue;
      }
      seenDepth.set(current.urn, current.depth);

      const node = await this.graph.getNode(current.urn);
      if (!node) continue;
      nodes.set(node.urn, {
        id: node.urn,
        urn: node.urn,
        entity_type: node.entity_type,
        label: buildNodeLabel(node.entity_type, node.properties, node.urn),
        properties: node.properties,
      });

      if (current.depth >= input.depth) {
        continue;
      }

      const outgoing = await this.graph.listEdgesFrom(current.urn);
      for (const edge of outgoing) {
        const edgeId = `${edge.from_urn}|${edge.predicate}|${edge.to_urn}`;
        edges.set(edgeId, {
          id: edgeId,
          from_urn: edge.from_urn,
          to_urn: edge.to_urn,
          predicate: edge.predicate,
          label: edge.predicate,
        });

        const targetNode = await this.graph.getNode(edge.to_urn);
        if (targetNode) {
          nodes.set(targetNode.urn, {
            id: targetNode.urn,
            urn: targetNode.urn,
            entity_type: targetNode.entity_type,
            label: buildNodeLabel(targetNode.entity_type, targetNode.properties, targetNode.urn),
            properties: targetNode.properties,
          });
          queue.push({ urn: targetNode.urn, depth: current.depth + 1 });
        }
      }
    }

    return {
      root_urn: input.root_urn,
      depth: input.depth,
      nodes: [...nodes.values()].sort((left, right) => left.urn.localeCompare(right.urn)),
      edges: [...edges.values()].sort((left, right) => left.id.localeCompare(right.id)),
    };
  }
}

function buildNodeLabel(entityType: string, properties: Record<string, unknown>, urn: string) {
  const displayName = stringValue(properties['display_name']);
  const skillKey = stringValue(properties['skill_key']);
  const agentKey = stringValue(properties['agent_key']);
  const harnessName = stringValue(properties['harness_name']);
  const taskId = stringValue(properties['task_id']);
  const operation = stringValue(properties['operation']);
  const sha256 = stringValue(properties['sha256']);
  const version = numberValue(properties['version']);

  switch (entityType) {
    case 'AGENT':
      return displayName ?? agentKey ?? urn;
    case 'SKILL':
      return displayName ?? skillKey ?? urn;
    case 'SKILL_VERSION':
      return `${skillKey ?? 'skill'}@v${version ?? '?'}`;
    case 'ARTIFACT':
      return sha256 ? `artifact:${sha256.slice(0, 12)}` : urn;
    case 'HARNESS':
      return harnessName ?? urn;
    case 'TASK':
      return operation && taskId ? `${operation}:${taskId.slice(0, 8)}` : taskId ?? urn;
    default:
      return displayName ?? skillKey ?? agentKey ?? urn;
  }
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}
