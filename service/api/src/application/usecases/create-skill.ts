import type { SkillRegistry, CreateResult } from '../ports/skill-registry.js';
import type { CreateSkillInput, CreateSkillOutput } from '../../contracts/skills/create-skill.js';

export class CreateSkillUseCase {
  constructor(private readonly registry: SkillRegistry) {}

  async execute(input: CreateSkillInput): Promise<CreateResult<CreateSkillOutput>> {
    return await this.registry.createSkill(input);
  }
}
