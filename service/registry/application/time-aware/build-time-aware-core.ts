import type { ArtifactStore } from '../../domain/signet/db/graph/freeform/registry/artifact-store.js';
import type { GraphStore } from '../../domain/signet/db/graph/freeform/registry/graph-store.js';
import { DefaultTimeAwareRegistry } from './services/default-time-aware-registry.js';

export function buildTimeAwareCore(input: {
  graph: GraphStore;
  cas: ArtifactStore;
}) {
  const service = new DefaultTimeAwareRegistry({
    graph: input.graph,
    cas: input.cas,
  });

  return {
    service,
  };
}
