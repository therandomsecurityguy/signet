import type { RegistrySearchPort } from '../ports/registry-search.js';
import type { SearchRegistryInput, SearchRegistryOutput } from '../../contracts/search/search-registry.js';

export class SearchRegistryUseCase {
  constructor(private readonly registry: RegistrySearchPort) {}

  async execute(input: SearchRegistryInput): Promise<SearchRegistryOutput> {
    const result = await this.registry.search({
      query: input.query,
      type: input.type,
      mode: input.mode,
      sort: input.sort,
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    });
    return {
      query: input.query,
      mode: input.mode,
      skills: result.skills.map((skill) => ({
        skill_urn: skill.skill_urn,
        skill_key: skill.skill_key,
        ...(skill.display_name ? { display_name: skill.display_name } : {}),
        ...(skill.description ? { description: skill.description } : {}),
        ...(skill.source_path ? { source_path: skill.source_path } : {}),
        ...(skill.active_version ? { active_version: skill.active_version } : {}),
        trust: skill.trust,
        match: skill.match,
      })),
      agents: result.agents.map((agent) => ({
        agent_urn: agent.agent_urn,
        agent_key: agent.agent_key,
        ...(agent.harness_name ? { harness_name: agent.harness_name } : {}),
        ...(agent.display_name ? { display_name: agent.display_name } : {}),
        ...(agent.description ? { description: agent.description } : {}),
        ...(agent.source_path ? { source_path: agent.source_path } : {}),
        trust: agent.trust,
        match: agent.match,
      })),
    };
  }
}
