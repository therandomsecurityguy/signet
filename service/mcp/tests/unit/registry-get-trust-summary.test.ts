import { describe, expect, it } from 'vitest';

import { InMemoryGraphStore } from '../../../registry/domain/signet/db/graph/freeform/registry/graph-store.js';
import type { ArtifactStore } from '../../../registry/domain/signet/db/graph/freeform/registry/artifact-store.js';
import {
  agentUrn,
  agentVersionUrn,
  skillUrn,
  skillVersionUrn,
} from '../../../registry/domain/signet/db/graph/freeform/registry/urn.js';
import type { RegistryService } from '../../../registry/application/ports/registry-service.js';
import type { ExecutionContext } from '../../src/application/ports/warehouse-connector.js';
import { InMemoryRegistryConnector } from '../../src/infrastructure/registry/inmemory-registry-connector.js';
import { REGISTRY_READ_GATE_OFF, RegistryReadGate } from '../../src/infrastructure/registry/read-gate.js';
import { RegistryGetSkillOutputSchema } from '../../src/contracts/tools/registry-get-skill.js';

function buildConnector(graph: InMemoryGraphStore) {
  return new InMemoryRegistryConnector(
    { graph, cas: {} as unknown as ArtifactStore },
    new RegistryReadGate({} as unknown as RegistryService, REGISTRY_READ_GATE_OFF),
  );
}

async function seedSkill(graph: InMemoryGraphStore, skillKey: string, activeVersion?: number) {
  const node = await graph.getNode(skillUrn(skillKey));
  await graph.upsertNode({
    urn: skillUrn(skillKey),
    entity_type: 'SKILL',
    properties: {
      skill_key: skillKey,
      ...(node?.properties ?? {}),
      ...(activeVersion ? { active_version_urn: skillVersionUrn(skillKey, activeVersion) } : {}),
    },
  });
}

async function seedAgent(graph: InMemoryGraphStore, agentKey: string, activeVersion?: number) {
  const node = await graph.getNode(agentUrn(agentKey));
  await graph.upsertNode({
    urn: agentUrn(agentKey),
    entity_type: 'AGENT',
    properties: {
      agent_key: agentKey,
      ...(node?.properties ?? {}),
      ...(activeVersion ? { active_version_urn: agentVersionUrn(agentKey, activeVersion) } : {}),
    },
  });
}

async function seedVersion(
  graph: InMemoryGraphStore,
  input: {
    logical_urn: string;
    version_urn: string;
    entity_type: 'SKILL_VERSION' | 'AGENT_VERSION';
    properties: Record<string, unknown>;
  },
) {
  await graph.upsertNode({ urn: input.version_urn, entity_type: input.entity_type, properties: input.properties });
  await graph.upsertEdge({ from_urn: input.logical_urn, to_urn: input.version_urn, predicate: 'sg:hasVersion', properties: {} });
}

const ctx = {} as ExecutionContext;

describe('registry.get_skill / get_agent trust summary', () => {
  it('answers verified_at / revoked / newer_available / expires_at from recorded evidence', async () => {
    const graph = new InMemoryGraphStore();
    await seedSkill(graph, 'skill:trusted', 1);
    await seedVersion(graph, {
      logical_urn: skillUrn('skill:trusted'),
      version_urn: skillVersionUrn('skill:trusted', 1),
      entity_type: 'SKILL_VERSION',
      properties: {
        skill_key: 'skill:trusted',
        version: 1,
        lifecycle_status: 'published',
        published_at: '2026-11-01T00:00:00.000Z',
        validated_at: '2026-11-01T00:00:00.000Z',
      },
    });
    // A newer published sibling exists but is not active.
    await seedVersion(graph, {
      logical_urn: skillUrn('skill:trusted'),
      version_urn: skillVersionUrn('skill:trusted', 2),
      entity_type: 'SKILL_VERSION',
      properties: {
        skill_key: 'skill:trusted',
        version: 2,
        lifecycle_status: 'published',
        published_at: '2026-11-20T00:00:00.000Z',
      },
    });

    const connector = buildConnector(graph);
    const out = await connector.getSkill({ skill_urn: skillUrn('skill:trusted') }, ctx);
    expect(RegistryGetSkillOutputSchema.safeParse(out).success).toBe(true);
    expect(out.trust_summary).toEqual({
      publication_urn: skillVersionUrn('skill:trusted', 1),
      verified_at: '2026-11-01T00:00:00.000Z',
      revoked: false,
      newer_available: true,
      expires_at: null,
      latest_trusted_version: 2,
      // The summary describes usage recorded before this load; the load
      // being served is counted after the summary is derived.
      load_count: null,
      last_loaded_at: null,
    });

    // Loads become visible to subsequent consumers (aggregate, no identities).
    await connector.getSkill({ skill_urn: skillUrn('skill:trusted') }, ctx);
    const second = await connector.getSkill({ skill_urn: skillUrn('skill:trusted') }, ctx);
    expect(second.trust_summary?.load_count).toBe(2);
    expect(second.trust_summary?.last_loaded_at).toBeTruthy();
  });

  it('reports revoked certifications with their expiry and never invents newer versions', async () => {
    const graph = new InMemoryGraphStore();
    await seedSkill(graph, 'skill:revoked-cert', 1);
    await seedVersion(graph, {
      logical_urn: skillUrn('skill:revoked-cert'),
      version_urn: skillVersionUrn('skill:revoked-cert', 1),
      entity_type: 'SKILL_VERSION',
      properties: {
        skill_key: 'skill:revoked-cert',
        version: 1,
        lifecycle_status: 'revoked',
        publication_status: 'revoked',
        revoked: true,
        certified: true,
        certified_at: '2026-06-01T00:00:00.000Z',
        certification_expires_at: '2027-06-01T00:00:00.000Z',
      },
    });

    const connector = buildConnector(graph);
    const out = await connector.getSkill({ skill_urn: skillUrn('skill:revoked-cert') }, ctx);
    expect(out.trust_summary).toMatchObject({
      verified_at: '2026-06-01T00:00:00.000Z',
      revoked: true,
      newer_available: false,
      expires_at: '2027-06-01T00:00:00.000Z',
      latest_trusted_version: 1,
    });
  });

  it('summarizes agent versions too', async () => {
    const graph = new InMemoryGraphStore();
    await seedAgent(graph, 'agent:cursor:trust-probe', 1);
    await seedVersion(graph, {
      logical_urn: agentUrn('agent:cursor:trust-probe'),
      version_urn: agentVersionUrn('agent:cursor:trust-probe', 1),
      entity_type: 'AGENT_VERSION',
      properties: {
        agent_key: 'agent:cursor:trust-probe',
        version: 1,
        lifecycle_status: 'published',
        published_at: '2026-10-01T00:00:00.000Z',
      },
    });
    await seedVersion(graph, {
      logical_urn: agentUrn('agent:cursor:trust-probe'),
      version_urn: agentVersionUrn('agent:cursor:trust-probe', 2),
      entity_type: 'AGENT_VERSION',
      properties: {
        agent_key: 'agent:cursor:trust-probe',
        version: 2,
        lifecycle_status: 'certified',
        certified: true,
        certified_at: '2026-11-25T00:00:00.000Z',
      },
    });

    const connector = buildConnector(graph);
    const out = await connector.getAgent({ agent_urn: agentUrn('agent:cursor:trust-probe') }, ctx);
    expect(out.trust_summary).toMatchObject({
      publication_urn: agentVersionUrn('agent:cursor:trust-probe', 1),
      newer_available: true,
      latest_trusted_version: 2,
      revoked: false,
    });
  });

  it('omits the summary when there is no active version to describe', async () => {
    const graph = new InMemoryGraphStore();
    await seedSkill(graph, 'skill:draft-only');
    await seedVersion(graph, {
      logical_urn: skillUrn('skill:draft-only'),
      version_urn: skillVersionUrn('skill:draft-only', 1),
      entity_type: 'SKILL_VERSION',
      properties: { skill_key: 'skill:draft-only', version: 1, lifecycle_status: 'draft' },
    });

    const connector = buildConnector(graph);
    const out = await connector.getSkill({ skill_urn: skillUrn('skill:draft-only') }, ctx);
    expect(out.trust_summary).toBeUndefined();
  });
});
