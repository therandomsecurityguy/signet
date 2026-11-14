import type { ToolRegistry } from '../../domain/tools/tool-registry.js';

export type ToolDescriptor = {
  name: string;
  version: string;
  description: string;
  risk_tier: string;
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
};

export class ListToolsUseCase {
  constructor(private readonly registry: ToolRegistry) {}

  async execute(): Promise<{ tools: ToolDescriptor[] }> {
    const tools = this.registry.list().map((t) => ({
      name: t.name,
      version: t.version,
      description: t.description,
      risk_tier: t.risk_tier,
      // PHASE 1: keep schema publishing minimal; registry Zod schemas remain canonical.
      input_schema: {},
      output_schema: {},
    }));

    return { tools };
  }
}

