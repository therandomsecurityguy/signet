import type { SkillRegistry } from '../ports/skill-registry.js';
import type { GetSkillInput, GetSkillOutput } from '../../contracts/skills/get-skill.js';

export class GetSkillUseCase {
  constructor(private readonly registry: SkillRegistry) {}

  async execute(input: GetSkillInput): Promise<GetSkillOutput | null> {
    return await this.registry.getSkill(input);
  }
}
