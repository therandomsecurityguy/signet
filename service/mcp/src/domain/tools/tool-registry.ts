import {
  DataDescribeTableInputSchema,
  DataDescribeTableOutputSchema,
} from '../../contracts/tools/data-describe-table.js';
import {
  DataListTablesInputSchema,
  DataListTablesOutputSchema,
} from '../../contracts/tools/data-list-tables.js';
import {
  DataQueryInputSchema,
  DataQueryOutputSchema,
} from '../../contracts/tools/data-query.js';
import {
  RegistryGetAgentInputSchema,
  RegistryGetAgentOutputSchema,
} from '../../contracts/tools/registry-get-agent.js';
import {
  RegistryGetArtifactInputSchema,
  RegistryGetArtifactOutputSchema,
} from '../../contracts/tools/registry-get-artifact.js';
import {
  RegistryGetProvenanceInputSchema,
  RegistryGetProvenanceOutputSchema,
} from '../../contracts/tools/registry-get-provenance.js';
import {
  RegistryVerifyPublicationInputSchema,
  RegistryVerifyPublicationOutputSchema,
} from '../../contracts/tools/registry-verify-publication.js';
import {
  RegistryGetAttestationsInputSchema,
  RegistryGetAttestationsOutputSchema,
} from '../../contracts/tools/registry-get-attestations.js';
import {
  RegistryGetSkillInputSchema,
  RegistryGetSkillOutputSchema,
} from '../../contracts/tools/registry-get-skill.js';
import {
  RegistryListAgentsInputSchema,
  RegistryListAgentsOutputSchema,
} from '../../contracts/tools/registry-list-agents.js';
import {
  RegistryListSkillsInputSchema,
  RegistryListSkillsOutputSchema,
} from '../../contracts/tools/registry-list-skills.js';
import {
  RegistrySearchInputSchema,
  RegistrySearchOutputSchema,
} from '../../contracts/tools/registry-search.js';
import type { ToolDefinition } from './tool-definition.js';
import { ToolName } from './tool-names.js';

export class ToolRegistry {
  private readonly toolsByName: Map<string, ToolDefinition>;

  private constructor(tools: ToolDefinition[]) {
    this.toolsByName = new Map(tools.map((t) => [t.name, t]));
  }

  static buildDefault(): ToolRegistry {
    return new ToolRegistry([
      {
        name: ToolName.DataQuery,
        version: '1.0.0',
        description: 'Run a read-only SQL query against an approved data source.',
        risk_tier: 'READ_ONLY',
        inputSchema: DataQueryInputSchema,
        outputSchema: DataQueryOutputSchema,
      },
      {
        name: ToolName.DataListTables,
        version: '1.0.0',
        description: 'List tables available in a data source.',
        risk_tier: 'READ_ONLY',
        inputSchema: DataListTablesInputSchema,
        outputSchema: DataListTablesOutputSchema,
      },
      {
        name: ToolName.DataDescribeTable,
        version: '1.0.0',
        description: 'Describe a table (columns and basic metadata).',
        risk_tier: 'READ_ONLY',
        inputSchema: DataDescribeTableInputSchema,
        outputSchema: DataDescribeTableOutputSchema,
      },

      {
        name: ToolName.RegistryListAgents,
        version: '1.0.0',
        description: 'List agents in the registry.',
        risk_tier: 'READ_ONLY',
        inputSchema: RegistryListAgentsInputSchema,
        outputSchema: RegistryListAgentsOutputSchema,
      },
      {
        name: ToolName.RegistryGetAgent,
        version: '1.0.0',
        description: 'Get an agent and its linked entities (skills/artifacts/harnesses).',
        risk_tier: 'READ_ONLY',
        inputSchema: RegistryGetAgentInputSchema,
        outputSchema: RegistryGetAgentOutputSchema,
      },
      {
        name: ToolName.RegistryListSkills,
        version: '1.0.0',
        description: 'List skills in the registry.',
        risk_tier: 'READ_ONLY',
        inputSchema: RegistryListSkillsInputSchema,
        outputSchema: RegistryListSkillsOutputSchema,
      },
      {
        name: ToolName.RegistryGetSkill,
        version: '1.0.0',
        description: 'Get a skill and its linked artifacts.',
        risk_tier: 'READ_ONLY',
        inputSchema: RegistryGetSkillInputSchema,
        outputSchema: RegistryGetSkillOutputSchema,
      },
      {
        name: ToolName.RegistryGetArtifact,
        version: '1.0.0',
        description:
          'Fetch an artifact (content-addressed file) by sha256/URN. The response re-hashes the bytes; treat digest_verified: false as untrusted.',
        risk_tier: 'READ_ONLY',
        inputSchema: RegistryGetArtifactInputSchema,
        outputSchema: RegistryGetArtifactOutputSchema,
      },
{
        name: ToolName.RegistryGetProvenance,
        version: '1.0.0',
        description: 'Get the PROV-O provenance chain and audit replay for a publication version.',
        risk_tier: 'READ_ONLY',
        inputSchema: RegistryGetProvenanceInputSchema,
        outputSchema: RegistryGetProvenanceOutputSchema,
      },
      {
        name: ToolName.RegistryVerifyPublication,
        version: '1.0.0',
        description:
          'Verify a published version before use: envelope digests, frozen-envelope artifact, detached signatures, and transparency proofs. Treat verification_status other than verified as untrusted.',
        risk_tier: 'READ_ONLY',
        inputSchema: RegistryVerifyPublicationInputSchema,
        outputSchema: RegistryVerifyPublicationOutputSchema,
      },
      {
        name: ToolName.RegistryGetAttestations,
        version: '1.0.0',
        description:
          'List DSSE/in-toto attestations attached to a published version (build provenance, SBOMs, scan results) with their verification status.',
        risk_tier: 'READ_ONLY',
        inputSchema: RegistryGetAttestationsInputSchema,
        outputSchema: RegistryGetAttestationsOutputSchema,
      },
      {
        name: ToolName.RegistrySearch,
        version: '1.1.0',
        description:
          'Search the registry for skills and agents by name, key, or description. Results are ranked by the deterministic trust score (certification tier dominates, then publication recency; ties break on the key) and include the score components for each result.',
        risk_tier: 'READ_ONLY',
        inputSchema: RegistrySearchInputSchema,
        outputSchema: RegistrySearchOutputSchema,
      },
    ]);
  }

  list(): ToolDefinition[] {
    return [...this.toolsByName.values()];
  }

  get(name: string): ToolDefinition | undefined {
    return this.toolsByName.get(name);
  }
}

