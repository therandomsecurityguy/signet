import type { RegistryConnector } from '../../application/ports/registry-connector.js';
import type { ExecutionContext } from '../../application/ports/warehouse-connector.js';
import type { RegistryService } from '../../../../registry/application/ports/registry-service.js';
import { RegistryCoreError } from '../../../../registry/application/errors/registry-core-error.js';
import { DomainError } from '../../domain/errors/domain-error.js';
import { ErrorCode } from '../../domain/errors/error-codes.js';
import type {
  RegistryGetAgentInput,
  RegistryGetAgentOutput,
} from '../../contracts/tools/registry-get-agent.js';
import type {
  RegistryGetArtifactInput,
  RegistryGetArtifactOutput,
} from '../../contracts/tools/registry-get-artifact.js';
import type {
  RegistryGetSkillInput,
  RegistryGetSkillOutput,
} from '../../contracts/tools/registry-get-skill.js';
import type {
  RegistryListAgentsInput,
  RegistryListAgentsOutput,
} from '../../contracts/tools/registry-list-agents.js';
import type {
  RegistryListSkillsInput,
  RegistryListSkillsOutput,
} from '../../contracts/tools/registry-list-skills.js';
import type {
  RegistryGetProvenanceInput,
  RegistryGetProvenanceOutput,
} from '../../contracts/tools/registry-get-provenance.js';
import type {
  RegistrySearchInput,
  RegistrySearchOutput,
} from '../../contracts/tools/registry-search.js';
import type {
  RegistryVerifyPublicationInput,
  RegistryVerifyPublicationOutput,
} from '../../contracts/tools/registry-verify-publication.js';
import type {
  RegistryGetAttestationsInput,
  RegistryGetAttestationsOutput,
} from '../../contracts/tools/registry-get-attestations.js';
import { toVerifyPublicationOutput } from './publication-verification-output.js';
import type { RegistryReadGate } from './read-gate.js';
import { artifactUrn } from '../../../../registry/domain/signet/db/graph/freeform/registry/urn.js';

export class RegistryServiceConnector implements RegistryConnector {
  constructor(
    private readonly service: RegistryService,
    private readonly readGate: RegistryReadGate,
  ) {}

  async listAgents(input: RegistryListAgentsInput, _ctx: ExecutionContext): Promise<RegistryListAgentsOutput> {
    const result = await this.service.listAgents({
      ...(input.harness_name ? { harness_name: input.harness_name } : {}),
      ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
      ...(typeof input.offset === 'number' ? { offset: input.offset } : {}),
    });
    const agents: RegistryListAgentsOutput['agents'] = [];
    for (const agent of result.agents) {
      if (this.readGate.enabled && !(await this.agentReadable(agent.agent_urn))) continue;
      agents.push({
        agent_urn: agent.agent_urn,
        agent_key: agent.agent_key,
        ...(agent.harness_name ? { harness_name: agent.harness_name } : {}),
        ...(agent.source_path ? { source_path: agent.source_path } : {}),
        ...(agent.tags?.length ? { tags: agent.tags } : {}),
      });
    }
    return { agents };
  }

  async getAgent(input: RegistryGetAgentInput, _ctx: ExecutionContext): Promise<RegistryGetAgentOutput> {
    const got = await this.service.getAgentByUrn({ agent_urn: input.agent_urn });
    if (!got) {
      throw new DomainError({
        code: ErrorCode.RegistryEntityNotFound,
        httpStatus: 404,
        safeMessage: 'Registry entity not found.',
      });
    }
    await this.readGate.assertPublicationReadable({
      publication_urn: got.active_version?.agent_version.urn,
      properties: got.active_version?.agent_version.properties,
    });
    return got;
  }

  async listSkills(input: RegistryListSkillsInput, _ctx: ExecutionContext): Promise<RegistryListSkillsOutput> {
    const result = await this.service.listSkills({
      ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
      ...(typeof input.offset === 'number' ? { offset: input.offset } : {}),
    });
    const skills: RegistryListSkillsOutput['skills'] = [];
    for (const skill of result.skills) {
      if (this.readGate.enabled && !(await this.skillReadable(skill.skill_urn))) continue;
      skills.push({
        skill_urn: skill.skill_urn,
        skill_key: skill.skill_key,
        ...(skill.source_path ? { source_path: skill.source_path } : {}),
        ...(skill.tags?.length ? { tags: skill.tags } : {}),
      });
    }
    return { skills };
  }

  async getSkill(input: RegistryGetSkillInput, _ctx: ExecutionContext): Promise<RegistryGetSkillOutput> {
    const got = await this.service.getSkillByUrn({ skill_urn: input.skill_urn });
    if (!got) {
      throw new DomainError({
        code: ErrorCode.RegistryEntityNotFound,
        httpStatus: 404,
        safeMessage: 'Registry entity not found.',
      });
    }
    await this.readGate.assertPublicationReadable({
      publication_urn: got.active_version?.skill_version.urn,
      properties: got.active_version?.skill_version.properties,
    });
    return got;
  }

  async getAttestations(
    input: RegistryGetAttestationsInput,
    _ctx: ExecutionContext,
  ): Promise<RegistryGetAttestationsOutput> {
    const got = await this.service.listAttestations({ publication_urn: input.version_urn });
    if (!got) {
      throw new DomainError({
        code: ErrorCode.RegistryEntityNotFound,
        httpStatus: 404,
        safeMessage: 'Registry entity not found.',
      });
    }
    return {
      attestations: got.attestations.map((attestation) => ({
        artifact_urn: attestation.artifact_urn,
        sha256: attestation.sha256,
        signer: attestation.signer,
        key_ref: attestation.key_ref,
        algorithm: attestation.algorithm,
        predicate_type: attestation.predicate_type,
        signature_valid: attestation.signature_valid,
        subject_bound: attestation.subject_bound,
        subject_digests: attestation.subject_digests,
        attached_at: attestation.attached_at,
      })),
    };
  }

  async verifyPublication(
    input: RegistryVerifyPublicationInput,
    _ctx: ExecutionContext,
  ): Promise<RegistryVerifyPublicationOutput> {
    const got = await this.service.getPublicationVerification({ publication_urn: input.version_urn });
    if (!got) {
      throw new DomainError({
        code: ErrorCode.RegistryEntityNotFound,
        httpStatus: 404,
        safeMessage: 'Registry entity not found.',
      });
    }
    return toVerifyPublicationOutput(got);
  }

  async getProvenance(
    input: RegistryGetProvenanceInput,
    _ctx: ExecutionContext,
  ): Promise<RegistryGetProvenanceOutput> {
    const got = await this.service.getPublicationProvenance({ publication_urn: input.version_urn });
    if (!got) {
      throw new DomainError({
        code: ErrorCode.RegistryEntityNotFound,
        httpStatus: 404,
        safeMessage: 'Registry entity not found.',
      });
    }
    return got;
  }

  async getArtifact(
    input: RegistryGetArtifactInput,
    _ctx: ExecutionContext,
  ): Promise<RegistryGetArtifactOutput> {
    let got;
    try {
      got = await this.service.getArtifact({
        ...(input.sha256 ? { sha256: input.sha256 } : {}),
        ...(input.artifact_urn ? { artifact_urn: input.artifact_urn } : {}),
      });
    } catch (err) {
      // In enforce mode a CAS object whose bytes do not hash to its content
      // address fails the read; surface the specific reason code instead of a
      // generic internal error.
      if (err instanceof RegistryCoreError && err.code === 'ARTIFACT_DIGEST_MISMATCH') {
        throw new DomainError({
          code: ErrorCode.RegistryArtifactDigestMismatch,
          httpStatus: 409,
          safeMessage: 'Artifact failed its digest verification.',
        });
      }
      throw err;
    }
    if (!got) {
      throw new DomainError({
        code: ErrorCode.RegistryArtifactNotFound,
        httpStatus: 404,
        safeMessage: 'Registry artifact not found.',
      });
    }
    await this.readGate.assertArtifactReadable({ artifact_urn: artifactUrn(got.sha256) });
    // Map explicitly: the tool surface stays intentional, and future core
    // fields cannot leak into structured content unnoticed.
    return {
      sha256: got.sha256,
      size_bytes: got.size_bytes,
      ...(got.media_type ? { media_type: got.media_type } : {}),
      content: got.content,
      content_truncated: got.content_truncated,
      digest_verified: got.digest_verified,
    };
  }

  async search(input: RegistrySearchInput, _ctx: ExecutionContext): Promise<RegistrySearchOutput> {
    // Search semantics (keyword/semantic modes, trust ranking, match
    // components) live in the registry core; this connector only applies
    // the read gates and projects to the MCP contract.
    const result = await this.service.searchRegistry({
      query: input.query,
      type: input.type,
      mode: input.mode,
      ...(input.sort ? { sort: input.sort } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    });

    const skills: RegistrySearchOutput['skills'] = [];
    for (const skill of result.skills) {
      if (this.readGate.enabled && !(await this.skillReadable(skill.skill_urn))) continue;
      skills.push({
        skill_urn: skill.skill_urn,
        skill_key: skill.skill_key,
        ...(skill.display_name ? { display_name: skill.display_name } : {}),
        ...(skill.description ? { description: skill.description } : {}),
        ...(skill.source_path ? { source_path: skill.source_path } : {}),
        ...(skill.active_version ? { active_version: skill.active_version } : {}),
        ...(skill.tags?.length ? { tags: skill.tags } : {}),
        ...(skill.freshness ? { freshness: skill.freshness } : {}),
        trust: skill.trust,
        match: skill.match,
      });
    }

    const agents: RegistrySearchOutput['agents'] = [];
    for (const agent of result.agents) {
      if (this.readGate.enabled && !(await this.agentReadable(agent.agent_urn))) continue;
      agents.push({
        agent_urn: agent.agent_urn,
        agent_key: agent.agent_key,
        ...(agent.harness_name ? { harness_name: agent.harness_name } : {}),
        ...(agent.display_name ? { display_name: agent.display_name } : {}),
        ...(agent.description ? { description: agent.description } : {}),
        ...(agent.source_path ? { source_path: agent.source_path } : {}),
        ...(agent.tags?.length ? { tags: agent.tags } : {}),
        ...(agent.freshness ? { freshness: agent.freshness } : {}),
        trust: agent.trust,
        match: agent.match,
      });
    }

    return { query: input.query, skills, agents };
  }

  // Enumeration paths (search/list) honor the same gates as get_*: a revoked
  // (or, under the strict gate, unverified) active publication is not
  // discoverable. Only runs when a gate is enabled; bounded by tool limits.
  private async skillReadable(skillUrnValue: string): Promise<boolean> {
    try {
      const got = await this.service.getSkillByUrn({ skill_urn: skillUrnValue });
      if (!got) return false;
      await this.readGate.assertPublicationReadable({
        publication_urn: got.active_version?.skill_version.urn,
        properties: got.active_version?.skill_version.properties,
      });
      return true;
    } catch (err) {
      if (err instanceof DomainError) return false;
      throw err;
    }
  }

  private async agentReadable(agentUrnValue: string): Promise<boolean> {
    try {
      const got = await this.service.getAgentByUrn({ agent_urn: agentUrnValue });
      if (!got) return false;
      await this.readGate.assertPublicationReadable({
        publication_urn: got.active_version?.agent_version.urn,
        properties: got.active_version?.agent_version.properties,
      });
      return true;
    } catch (err) {
      if (err instanceof DomainError) return false;
      throw err;
    }
  }
}
