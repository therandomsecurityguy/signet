import { describe, expect, it } from 'vitest';

import { ToolRegistry } from '../../src/domain/tools/tool-registry.js';

describe('ToolRegistry', () => {
  it('registers the canonical tools uniquely', () => {
    const registry = ToolRegistry.buildDefault();
    const tools = registry.list();
    const names = tools.map((t) => t.name);

    expect(names).toEqual([
      'data.query',
      'data.list_tables',
      'data.describe_table',
      'registry.list_agents',
      'registry.get_agent',
      'registry.list_skills',
      'registry.get_skill',
      'registry.get_artifact',
      'registry.get_provenance',
      'registry.verify_publication',
      'registry.get_attestations',
      'registry.search',
    ]);
    expect(new Set(names).size).toBe(names.length);
  });
});

