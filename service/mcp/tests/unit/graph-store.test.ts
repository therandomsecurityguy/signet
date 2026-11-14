import { describe, expect, it } from 'vitest';

import { InMemoryGraphStore } from '../../../registry/domain/signet/db/graph/freeform/registry/graph-store.js';
import { agentUrn, skillUrn } from '../../../registry/domain/signet/db/graph/freeform/registry/urn.js';

describe('InMemoryGraphStore', () => {
  it('upserts and fetches nodes', async () => {
    const g = new InMemoryGraphStore();
    const a = agentUrn('cursor:example-agent');

    await g.upsertNode({
      urn: a,
      entity_type: 'AGENT',
      properties: { display_name: 'Example Agent' },
    });

    const got = await g.getNode(a);
    expect(got).not.toBeNull();
    expect(got!.entity_type).toBe('AGENT');
    expect(got!.properties['display_name']).toBe('Example Agent');
  });

  it('upserts edges and traverses from/to', async () => {
    const g = new InMemoryGraphStore();
    const a = agentUrn('cursor:example-agent');
    const s = skillUrn('skill:example-skill');

    await g.upsertEdge({
      from_urn: a,
      to_urn: s,
      predicate: 'sg:usesSkill',
      properties: {},
    });

    const from = await g.listEdgesFrom(a, 'sg:usesSkill');
    expect(from).toHaveLength(1);
    expect(from[0]!.to_urn).toBe(s);

    const to = await g.listEdgesTo(s, 'sg:usesSkill');
    expect(to).toHaveLength(1);
    expect(to[0]!.from_urn).toBe(a);
  });
});

