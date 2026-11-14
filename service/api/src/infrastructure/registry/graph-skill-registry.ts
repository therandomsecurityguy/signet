import type { CreateSkillInput, CreateSkillOutput } from '../../contracts/skills/create-skill.js';
import type { GetSkillInput, GetSkillOutput } from '../../contracts/skills/get-skill.js';
import type { ListSkillsInput, ListSkillsOutput } from '../../contracts/skills/list-skills.js';
import type { CreateResult, SkillRegistry } from '../../application/ports/skill-registry.js';
import { ApiError } from '../../domain/errors/api-error.js';
import { RegistryCoreError } from '../../../../registry/application/errors/registry-core-error.js';
import type { RegistryService } from '../../../../registry/application/ports/registry-service.js';

export class GraphSkillRegistry implements SkillRegistry {
  constructor(private readonly service: RegistryService) {}

  async listSkills(input: ListSkillsInput): Promise<ListSkillsOutput> {
    return await this.service.listSkills({
      ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
      ...(typeof input.offset === 'number' ? { offset: input.offset } : {}),
    });
  }

  async getSkill(input: GetSkillInput): Promise<GetSkillOutput | null> {
    return await this.service.getSkillByKey(input);
  }

  async createSkill(input: CreateSkillInput): Promise<CreateResult<CreateSkillOutput>> {
    try {
      return await this.service.createSkill({
        skill_key: input.skill_key,
        ...(input.display_name ? { display_name: input.display_name } : {}),
        ...(input.description ? { description: input.description } : {}),
        ...(input.source_path ? { source_path: input.source_path } : {}),
        ...(input.artifact
          ? {
              artifact: {
                content: input.artifact.content,
                encoding: input.artifact.encoding,
                ...(input.artifact.media_type ? { media_type: input.artifact.media_type } : {}),
                ...(input.artifact.original_path ? { original_path: input.artifact.original_path } : {}),
              },
            }
          : {}),
      });
    } catch (err) {
      throw mapRegistryError(err);
    }
  }
}

function mapRegistryError(err: unknown): ApiError {
  if (err instanceof RegistryCoreError) {
    switch (err.code) {
      case 'SKILL_CREATE_CONFLICT':
        return new ApiError('SKILL_CREATE_CONFLICT', 409, err.message);
      case 'SKILL_CREATE_FAILED':
        return new ApiError('SKILL_CREATE_FAILED', 500, err.message);
      default:
        return new ApiError(err.code, 500, err.message);
    }
  }
  if (err instanceof ApiError) return err;
  return new ApiError('INTERNAL_ERROR', 500, 'Internal error.');
}
