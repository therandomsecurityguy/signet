import type { AgentRegistry } from '../ports/agent-registry.js';
import type { ListAgentsInput, ListAgentsOutput } from '../../contracts/agents/list-agents.js';

export class ListAgentsUseCase {
  constructor(private readonly registry: AgentRegistry) {}

  async execute(input: ListAgentsInput): Promise<ListAgentsOutput> {
    return await this.registry.listAgents(input);
  }
}
