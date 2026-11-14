import type { CreateAgentInput, CreateAgentOutput } from '../../contracts/agents/create-agent.js';
import type { GetAgentInput, GetAgentOutput } from '../../contracts/agents/get-agent.js';
import type { ListAgentsInput, ListAgentsOutput } from '../../contracts/agents/list-agents.js';
import { ApiError } from '../../domain/errors/api-error.js';
import type { AgentRegistry } from '../../application/ports/agent-registry.js';
import type { CreateResult, RegistryService } from '../../../../registry/application/ports/registry-service.js';
import { RegistryCoreError } from '../../../../registry/application/errors/registry-core-error.js';

export class GraphAgentRegistry implements AgentRegistry {
  constructor(private readonly service: RegistryService) {}

  async listAgents(input: ListAgentsInput): Promise<ListAgentsOutput> {
    return await this.service.listAgents({
      ...(input.harness_name ? { harness_name: input.harness_name } : {}),
      ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
      ...(typeof input.offset === 'number' ? { offset: input.offset } : {}),
    });
  }

  async getAgent(input: GetAgentInput): Promise<GetAgentOutput | null> {
    return await this.service.getAgentByKey(input);
  }

  async createAgent(input: CreateAgentInput): Promise<CreateResult<CreateAgentOutput>> {
    try {
      return await this.service.createAgent({
        agent_key: input.agent_key,
        ...(input.harness_name ? { harness_name: input.harness_name } : {}),
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
        ...(input.skill_refs
          ? {
              skill_refs: input.skill_refs.map((ref) => ({
                ...(ref.skill_urn ? { skill_urn: ref.skill_urn } : {}),
                ...(ref.skill_key ? { skill_key: ref.skill_key } : {}),
              })),
            }
          : {}),
        ...(input.governance
          ? {
              governance: {
                ...(input.governance.publisher ? { publisher: input.governance.publisher } : {}),
                ...(input.governance.policy_version ? { policy_version: input.governance.policy_version } : {}),
                ...(input.governance.validation_report ? { validation_report: input.governance.validation_report } : {}),
                ...(input.governance.signature_ref ? { signature_ref: input.governance.signature_ref } : {}),
                ...(input.governance.approver ? { approver: input.governance.approver } : {}),
                ...(input.governance.approver_role ? { approver_role: input.governance.approver_role } : {}),
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
      case 'SKILL_NOT_FOUND':
        return new ApiError('SKILL_NOT_FOUND', 404, err.message);
      case 'SKILL_REFERENCE_INVALID':
        return new ApiError('SKILL_REFERENCE_INVALID', 400, err.message);
      case 'AGENT_CREATE_CONFLICT':
        return new ApiError('AGENT_CREATE_CONFLICT', 409, err.message);
      case 'AGENT_CREATE_FAILED':
        return new ApiError('AGENT_CREATE_FAILED', 500, err.message);
      default:
        return new ApiError(err.code, 500, err.message);
    }
  }
  if (err instanceof ApiError) return err;
  return new ApiError('INTERNAL_ERROR', 500, 'Internal error.');
}
