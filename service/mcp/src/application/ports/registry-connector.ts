import type { ExecutionContext } from './warehouse-connector.js';
import type {
  RegistryGetAgentInput,
  RegistryGetAgentOutput,
} from '../../contracts/tools/registry-get-agent.js';
import type {
  RegistryGetArtifactInput,
  RegistryGetArtifactOutput,
} from '../../contracts/tools/registry-get-artifact.js';
import type {
  RegistryGetProvenanceInput,
  RegistryGetProvenanceOutput,
} from '../../contracts/tools/registry-get-provenance.js';
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

export interface RegistryConnector {
  listAgents(input: RegistryListAgentsInput, ctx: ExecutionContext): Promise<RegistryListAgentsOutput>;
  getAgent(input: RegistryGetAgentInput, ctx: ExecutionContext): Promise<RegistryGetAgentOutput>;
  listSkills(input: RegistryListSkillsInput, ctx: ExecutionContext): Promise<RegistryListSkillsOutput>;
  getSkill(input: RegistryGetSkillInput, ctx: ExecutionContext): Promise<RegistryGetSkillOutput>;
  getArtifact(
    input: RegistryGetArtifactInput,
    ctx: ExecutionContext,
  ): Promise<RegistryGetArtifactOutput>;
  getProvenance(
    input: RegistryGetProvenanceInput,
    ctx: ExecutionContext,
  ): Promise<RegistryGetProvenanceOutput>;
  verifyPublication(
    input: RegistryVerifyPublicationInput,
    ctx: ExecutionContext,
  ): Promise<RegistryVerifyPublicationOutput>;
  getAttestations(
    input: RegistryGetAttestationsInput,
    ctx: ExecutionContext,
  ): Promise<RegistryGetAttestationsOutput>;
  search(input: RegistrySearchInput, ctx: ExecutionContext): Promise<RegistrySearchOutput>;
}

