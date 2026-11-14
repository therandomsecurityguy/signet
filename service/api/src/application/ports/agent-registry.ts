import type { CreateAgentInput, CreateAgentOutput } from '../../contracts/agents/create-agent.js';
import type { GetAgentInput, GetAgentOutput } from '../../contracts/agents/get-agent.js';
import type { ListAgentsInput, ListAgentsOutput } from '../../contracts/agents/list-agents.js';
import type { CreateResult } from './skill-registry.js';

export interface AgentRegistry {
  listAgents(input: ListAgentsInput): Promise<ListAgentsOutput>;
  getAgent(input: GetAgentInput): Promise<GetAgentOutput | null>;
  createAgent(input: CreateAgentInput): Promise<CreateResult<CreateAgentOutput>>;
}
