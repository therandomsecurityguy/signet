import { describe, expect, it } from 'vitest';

import { InMemoryGraphStore } from '../../../registry/domain/signet/db/graph/freeform/registry/graph-store.js';
import type { ArtifactStore } from '../../../registry/domain/signet/db/graph/freeform/registry/artifact-store.js';
import { skillVersionUrn } from '../../../registry/domain/signet/db/graph/freeform/registry/urn.js';
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

async function seedSkill(
  graph: InMemoryGraphStore,
  input: {
    skill_key: string;
    description: string;
    capability_claims?: string[];
    active_version?: {
      lifecycle_status: string;
      certified?: boolean;
      certified_at?: string;
      published_at?: string;
    };
  },
) {
  await graph.upsertNode({
    urn: `urn:sg:skill:${input.skill_key}`,
    entity_type: 'SKILL',
    properties: {
      skill_key: input.skill_key,
      description: input.description,
      ...(input.active_version
        ? { active_version_urn: skillVersionUrn(input.skill_key, 1) }
        : {}),
    },
  });
  if (input.active_version) {
    await graph.upsertNode({
      urn: skillVersionUrn(input.skill_key, 1),
      entity_type: 'SKILL_VERSION',
      properties: {
        skill_key: input.skill_key,
        version: 1,
        lifecycle_status: input.active_version.lifecycle_status,
        ...(input.capability_claims?.length ? { capability_claims: input.capability_claims } : {}),
        ...(input.active_version.certified ? { certified: true } : {}),
        ...(input.active_version.certified_at ? { certified_at: input.active_version.certified_at } : {}),
        ...(input.active_version.published_at ? { published_at: input.active_version.published_at } : {}),
      },
    });
  }
}

const ctx = {} as ExecutionContext;

describe('registry.search trust ranking (in-memory connector)', () => {
  it('orders matches by tier then recency and exposes the components', async () => {
    const graph = new InMemoryGraphStore();
    // Certified but old — must still outrank the fresh published one.
    await seedSkill(graph, {
      skill_key: 'skill:aaa-certified',
      description: 'shared term alpha',
      active_version: {
        lifecycle_status: 'published',
        certified: true,
        certified_at: '2025-01-01T00:00:00.000Z',
        published_at: '2025-01-01T00:00:00.000Z',
      },
    });
    await seedSkill(graph, {
      skill_key: 'skill:bbb-published',
      description: 'shared term alpha',
      active_version: {
        lifecycle_status: 'published',
        published_at: '2026-11-24T00:00:00.000Z',
      },
    });
    await seedSkill(graph, {
      skill_key: 'skill:ccc-bare',
      description: 'shared term alpha',
    });

    const connector = buildConnector(graph);
    const out = await connector.search(
      { query: 'shared term alpha', type: 'all', mode: 'keyword', sort: 'trust', limit: 10 },
      ctx,
    );

    expect(out.skills.map((skill) => skill.skill_key)).toEqual([
      'skill:aaa-certified',
      'skill:bbb-published',
      'skill:ccc-bare',
    ]);
    expect(out.skills[0]?.trust).toMatchObject({ lifecycle_status: 'certified', tier_weight: 3 });
    expect(out.skills[1]?.trust).toMatchObject({ lifecycle_status: 'published', tier_weight: 2 });
    expect(out.skills[2]?.trust).toMatchObject({ lifecycle_status: 'none', tier_weight: 0, score: 0 });
    expect(out.skills[0]?.match).toMatchObject({ mode: 'keyword', score: 1 });
  });

  it('keeps natural scan order for keyword sort=default while still exposing trust', async () => {
    const graph = new InMemoryGraphStore();
    await seedSkill(graph, {
      skill_key: 'skill:zzz-first',
      description: 'shared term alpha',
      active_version: { lifecycle_status: 'published', published_at: '2025-01-01T00:00:00.000Z' },
    });
    await seedSkill(graph, {
      skill_key: 'skill:aaa-second',
      description: 'shared term alpha',
      active_version: { lifecycle_status: 'published', published_at: '2026-11-24T00:00:00.000Z' },
    });

    const connector = buildConnector(graph);
    const out = await connector.search(
      { query: 'shared term alpha', type: 'all', mode: 'keyword', sort: 'default', limit: 10 },
      ctx,
    );
    expect(out.skills.map((skill) => skill.skill_key)).toEqual(['skill:zzz-first', 'skill:aaa-second']);
    expect(out.skills[0]?.trust).toMatchObject({ lifecycle_status: 'published' });
    expect(out.skills[0]?.match?.mode).toBe('keyword');

    // A query matching only a description still finds the skill.
    const byDescription = await connector.search(
      { query: 'shared term alpha', type: 'skill', mode: 'keyword', sort: 'trust', limit: 10 },
      ctx,
    );
    expect(byDescription.skills).toHaveLength(2);
  });

  it('matches capability claims and phrases in semantic mode, relevance first', async () => {
    const graph = new InMemoryGraphStore();
    await seedSkill(graph, {
      skill_key: 'skill:claims',
      description: 'Data workflows for regulated buckets.',
      capability_claims: ['pii-handling'],
      active_version: { lifecycle_status: 'published', published_at: '2026-11-24T00:00:00.000Z' },
    });
    await seedSkill(graph, {
      skill_key: 'skill:phrase',
      description: 'Handles PII handling pipelines daily.',
      active_version: { lifecycle_status: 'published', published_at: '2025-01-01T00:00:00.000Z' },
    });
    await seedSkill(graph, {
      skill_key: 'skill:unrelated',
      description: 'Gardening tips for balcony tomatoes.',
      active_version: { lifecycle_status: 'published', published_at: '2026-11-24T00:00:00.000Z' },
    });

    const connector = buildConnector(graph);
    const out = await connector.search(
      { query: 'PII handling pipelines', type: 'all', mode: 'semantic', sort: 'trust', limit: 10 },
      ctx,
    );
    expect(out.skills.map((skill) => skill.skill_key)).toEqual(['skill:phrase', 'skill:claims']);
    expect(out.skills[0]?.match).toMatchObject({ mode: 'semantic', phrase_match: true });
    expect(out.skills[1]?.match?.matched_claims).toEqual(['pii-handling']);
    expect(out.skills[0]?.trust).toBeDefined();
  });
});
