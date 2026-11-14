import type { AgentRegistry } from '../ports/agent-registry.js';
import type { CreateAgentInput, CreateAgentOutput } from '../../contracts/agents/create-agent.js';
import type { CreateResult } from '../ports/skill-registry.js';

export class CreateAgentUseCase {
  constructor(private readonly registry: AgentRegistry) {}

  async execute(input: CreateAgentInput): Promise<CreateResult<CreateAgentOutput>> {
    return await this.registry.createAgent(input);
  }
}
