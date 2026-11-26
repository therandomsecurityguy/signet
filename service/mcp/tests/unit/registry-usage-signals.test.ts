import { describe, expect, it } from 'vitest';

import { InMemoryGraphStore } from '../../../registry/domain/signet/db/graph/freeform/registry/graph-store.js';
import type { ArtifactStore } from '../../../registry/domain/signet/db/graph/freeform/registry/artifact-store.js';
import {
  skillUrn,
  skillVersionUrn,
  usageSignalUrn,
} from '../../../registry/domain/signet/db/graph/freeform/registry/urn.js';
import type { RegistryService } from '../../../registry/application/ports/registry-service.js';
import type { ExecutionContext } from '../../src/application/ports/warehouse-connector.js';
import { InMemoryRegistryConnector } from '../../src/infrastructure/registry/inmemory-registry-connector.js';
import { REGISTRY_READ_GATE_OFF, RegistryReadGate } from '../../src/infrastructure/registry/read-gate.js';

function buildConnector(graph: InMemoryGraphStore) {
  return new InMemoryRegistryConnector(
    { graph, cas: {} as unknown as ArtifactStore },
    new RegistryReadGate({} as unknown as RegistryService, REGISTRY_READ_GATE_OFF),
  );
}

const ctx = {} as ExecutionContext;

describe('MCP usage signals', () => {
  it('counts loads and verify encounters on usage nodes without identities', async () => {
    const graph = new InMemoryGraphStore();
    await graph.upsertNode({
      urn: skillUrn('skill:mcp-usage'),
      entity_type: 'SKILL',
      properties: {
        skill_key: 'skill:mcp-usage',
        active_version_urn: skillVersionUrn('skill:mcp-usage', 1),
      },
    });
    await graph.upsertNode({
      urn: skillVersionUrn('skill:mcp-usage', 1),
      entity_type: 'SKILL_VERSION',
      properties: {
        skill_key: 'skill:mcp-usage',
        version: 1,
        lifecycle_status: 'published',
        published_at: '2026-11-01T00:00:00.000Z',
      },
    });
    await graph.upsertEdge({
      from_urn: skillUrn('skill:mcp-usage'),
      to_urn: skillVersionUrn('skill:mcp-usage', 1),
      predicate: 'sg:hasVersion',
      properties: {},
    });

    const connector = buildConnector(graph);
    await connector.getSkill({ skill_urn: skillUrn('skill:mcp-usage') }, ctx);
    await connector.getSkill({ skill_urn: skillUrn('skill:mcp-usage') }, ctx);

    const signalUrn = usageSignalUrn('version', skillVersionUrn('skill:mcp-usage', 1));
    const usageNode = await graph.getNode(signalUrn);
    expect(usageNode?.properties['load_count']).toBe(2);
    expect(usageNode?.properties['last_loaded_at']).toBeTruthy();
    const keys = Object.keys(usageNode?.properties ?? {});
    for (const forbidden of ['actor', 'author', 'principal', 'client_name', 'request_id']) {
      expect(keys).not.toContain(forbidden);
    }

    await connector.verifyPublication({ version_urn: skillVersionUrn('skill:mcp-usage', 1) }, ctx);
    const afterVerify = await graph.getNode(signalUrn);
    const verifyTotal =
      ((afterVerify?.properties['verify_count'] as number | undefined) ?? 0) +
      ((afterVerify?.properties['verify_failure_count'] as number | undefined) ?? 0);
    expect(verifyTotal).toBe(1);
  });
});
