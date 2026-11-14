import type { CreateSkillInput, CreateSkillOutput } from '../../contracts/skills/create-skill.js';
import type { GetSkillInput, GetSkillOutput } from '../../contracts/skills/get-skill.js';
import type { ListSkillsInput, ListSkillsOutput } from '../../contracts/skills/list-skills.js';

export type CreateResult<T> = {
  value: T;
  created: boolean;
};

export interface SkillRegistry {
  listSkills(input: ListSkillsInput): Promise<ListSkillsOutput>;
  getSkill(input: GetSkillInput): Promise<GetSkillOutput | null>;
  createSkill(input: CreateSkillInput): Promise<CreateResult<CreateSkillOutput>>;
}
