import { describe, expect, it } from 'vitest';

import { ToolRegistry } from '../../src/domain/tools/tool-registry.js';

describe('contract: MCP tools == Tool API tools', () => {
  it('registry names equal canonical list', () => {
    // PHASE 5: MCP adapter derives tools from the same ToolRegistry.
    // This contract test asserts the canonical tool list is stable.
    const registry = ToolRegistry.buildDefault();
    const names = registry.list().map((t) => t.name);
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
  });
});

