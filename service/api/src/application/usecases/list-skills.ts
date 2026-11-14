import type { SkillRegistry } from '../ports/skill-registry.js';
import type { ListSkillsInput, ListSkillsOutput } from '../../contracts/skills/list-skills.js';

export class ListSkillsUseCase {
  constructor(private readonly registry: SkillRegistry) {}

  async execute(input: ListSkillsInput): Promise<ListSkillsOutput> {
    return await this.registry.listSkills(input);
  }
}
