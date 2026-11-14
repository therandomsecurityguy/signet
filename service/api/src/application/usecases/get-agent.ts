import type { AgentRegistry } from '../ports/agent-registry.js';
import type { GetAgentInput, GetAgentOutput } from '../../contracts/agents/get-agent.js';

export class GetAgentUseCase {
  constructor(private readonly registry: AgentRegistry) {}

  async execute(input: GetAgentInput): Promise<GetAgentOutput | null> {
    return await this.registry.getAgent(input);
  }
}
