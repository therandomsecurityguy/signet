import type { ArtifactStore } from '../../../../registry/domain/signet/db/graph/freeform/registry/artifact-store.js';
import { CasIntegrityError } from '../../../../registry/domain/signet/db/graph/freeform/registry/artifact-store.js';
import type { GraphStore } from '../../../../registry/domain/signet/db/graph/freeform/registry/graph-store.js';
import { DefaultRegistryService } from '../../../../registry/application/services/default-registry-service.js';
import { DomainError } from '../../domain/errors/domain-error.js';
import { ErrorCode } from '../../domain/errors/error-codes.js';
import type { RegistryConnector } from '../../application/ports/registry-connector.js';
import type { ExecutionContext } from '../../application/ports/warehouse-connector.js';
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

export class InMemoryRegistryConnector implements RegistryConnector {
  // Verification semantics live in the registry core. Rather than duplicating
  // them (and drifting), this double runs the real service over its own
  // graph/CAS, which is exactly what production wiring uses.
  private readonly verifier: DefaultRegistryService;

  constructor(
    private readonly deps: {
      graph: GraphStore;
      cas: ArtifactStore;
    },
    private readonly readGate: RegistryReadGate,
  ) {
    this.verifier = new DefaultRegistryService({ graph: deps.graph, cas: deps.cas });
  }

  async verifyPublication(
    input: RegistryVerifyPublicationInput,
    _ctx: ExecutionContext,
  ): Promise<RegistryVerifyPublicationOutput> {
    const got = await this.verifier.getPublicationVerification({ publication_urn: input.version_urn });
    if (!got) {
      throw new DomainError({
        code: ErrorCode.RegistryEntityNotFound,
        httpStatus: 404,
        safeMessage: 'Registry entity not found.',
      });
    }
    return toVerifyPublicationOutput(got);
  }

  async getAttestations(
    input: RegistryGetAttestationsInput,
    _ctx: ExecutionContext,
  ): Promise<RegistryGetAttestationsOutput> {
    const got = await this.verifier.listAttestations({ publication_urn: input.version_urn });
    if (!got) {
      throw new DomainError({
        code: ErrorCode.RegistryEntityNotFound,
        httpStatus: 404,
        safeMessage: 'Registry entity not found.',
      });
    }
    return { attestations: got.attestations };
  }

  private async activeVersionProperties(
    properties: Record<string, unknown>,
  ): Promise<Record<string, unknown> | undefined> {
    const urn = activeVersionUrn(properties);
    if (!urn) return undefined;
    const node = await this.deps.graph.getNode(urn);
    return node?.properties;
  }

  async listAgents(input: RegistryListAgentsInput, _ctx: ExecutionContext): Promise<RegistryListAgentsOutput> {
    const nodes = await this.deps.graph.listNodesByType('AGENT', {
      ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
      ...(typeof input.offset === 'number' ? { offset: input.offset } : {}),
    });
    const filtered = input.harness_name
      ? nodes.filter((n) => n.properties['harness_name'] === input.harness_name)
      : nodes;

    return {
      agents: filtered.map((n) => ({
        agent_urn: n.urn,
        agent_key: String(n.properties['agent_key'] ?? n.urn),
        ...(typeof n.properties['harness_name'] === 'string'
          ? { harness_name: n.properties['harness_name'] as string }
          : {}),
        ...(typeof n.properties['source_path'] === 'string'
          ? { source_path: n.properties['source_path'] as string }
          : {}),
      })),
    };
  }

  async getAgent(input: RegistryGetAgentInput, _ctx: ExecutionContext): Promise<RegistryGetAgentOutput> {
    const node = await this.deps.graph.getNode(input.agent_urn);
    if (!node) {
      return { agent: { urn: input.agent_urn, properties: {} }, skills: [], artifacts: [], harnesses: [] };
    }

    const skillsEdges = await this.deps.graph.listEdgesFrom(node.urn, 'sg:usesSkill');
    const artifactEdges = await this.deps.graph.listEdgesFrom(node.urn, 'sg:definedBy');
    const harnessEdges = await this.deps.graph.listEdgesFrom(node.urn, 'sg:runsOn');

    await this.readGate.assertPublicationReadable({
      publication_urn: activeVersionUrn(node.properties),
      properties: await this.activeVersionProperties(node.properties),
    });

    return {
      agent: { urn: node.urn, properties: node.properties },
      ...(typeof node.properties['active_version_urn'] === 'string'
        ? {
            active_version: {
              agent_version: {
                urn: String(node.properties['active_version_urn']),
                properties: {},
              },
              skills: [],
              artifacts: [],
              harnesses: [],
              governance_artifacts: [],
            },
          }
        : {}),
      skills: skillsEdges.map((e) => ({ skill_urn: e.to_urn })),
      artifacts: artifactEdges.map((e) => ({
        artifact_urn: e.to_urn,
        sha256: parseArtifactSha256(e.to_urn),
      })),
      harnesses: harnessEdges.map((e) => ({
        harness_urn: e.to_urn,
        harness_name: parseHarnessName(e.to_urn),
      })),
    };
  }

  async listSkills(input: RegistryListSkillsInput, _ctx: ExecutionContext): Promise<RegistryListSkillsOutput> {
    const nodes = await this.deps.graph.listNodesByType('SKILL', {
      ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
      ...(typeof input.offset === 'number' ? { offset: input.offset } : {}),
    });
    return {
      skills: nodes.map((n) => ({
        skill_urn: n.urn,
        skill_key: String(n.properties['skill_key'] ?? n.urn),
        ...(typeof n.properties['source_path'] === 'string'
          ? { source_path: n.properties['source_path'] as string }
          : {}),
      })),
    };
  }

  async getSkill(input: RegistryGetSkillInput, _ctx: ExecutionContext): Promise<RegistryGetSkillOutput> {
    const node = await this.deps.graph.getNode(input.skill_urn);
    if (!node) {
      return { skill: { urn: input.skill_urn, properties: {} }, artifacts: [] };
    }
    const artifactEdges = await this.deps.graph.listEdgesFrom(node.urn, 'sg:implementedBy');
    await this.readGate.assertPublicationReadable({
      publication_urn: activeVersionUrn(node.properties),
      properties: await this.activeVersionProperties(node.properties),
    });
    return {
      skill: { urn: node.urn, properties: node.properties },
      ...(typeof node.properties['active_version_urn'] === 'string'
        ? {
            active_version: {
              skill_version: {
                urn: String(node.properties['active_version_urn']),
                properties: {},
              },
              artifacts: [],
              upstream_versions: [],
              governance_artifacts: [],
            },
          }
        : {}),
      artifacts: artifactEdges.map((e) => ({
        artifact_urn: e.to_urn,
        sha256: parseArtifactSha256(e.to_urn),
      })),
    };
  }

  async getProvenance(
    input: RegistryGetProvenanceInput,
    _ctx: ExecutionContext,
  ): Promise<RegistryGetProvenanceOutput> {
    const start = await this.deps.graph.getNode(input.version_urn);
    if (!start || (start.entity_type !== 'SKILL_VERSION' && start.entity_type !== 'AGENT_VERSION')) {
      throw new DomainError({
        code: ErrorCode.RegistryEntityNotFound,
        httpStatus: 404,
        safeMessage: 'Registry entity not found.',
      });
    }

    const chainUrns: string[] = [];
    const derivedFromByUrn = new Map<string, string[]>();
    const visited = new Set<string>();
    let current: string | null = start.urn;
    while (current && !visited.has(current) && chainUrns.length < 50) {
      visited.add(current);
      chainUrns.push(current);
      const targets: string[] = (await this.deps.graph.listEdgesFrom(current, 'prov:wasDerivedFrom')).map((e) => e.to_urn);
      derivedFromByUrn.set(current, targets);
      current = targets[0] ?? null;
    }

    const derivation_chain: RegistryGetProvenanceOutput['derivation_chain'] = [];
    const replay: RegistryGetProvenanceOutput['replay'] = [];
    for (const versionUrn of chainUrns) {
      const targeting = await this.deps.graph.listEdgesTo(versionUrn, 'sg:targets');
      const activities: RegistryGetProvenanceOutput['derivation_chain'][number]['activities'] = [];
      for (const edge of targeting) {
        const taskNode = await this.deps.graph.getNode(edge.from_urn);
        if (!taskNode || taskNode.entity_type !== 'TASK') continue;
        const used = (await this.deps.graph.listEdgesFrom(taskNode.urn, 'prov:used')).map((e) => ({ urn: e.to_urn }));
        const associated_agents = (await this.deps.graph.listEdgesFrom(taskNode.urn, 'prov:wasAssociatedWith')).map(
          (e) => ({
            urn: e.to_urn,
            ...(typeof e.properties['role'] === 'string' ? { role: e.properties['role'] } : {}),
          }),
        );
        const operation = String(taskNode.properties['operation'] ?? 'unknown');
        const status = String(taskNode.properties['status'] ?? 'completed');
        const occurredAt = typeof taskNode.properties['occurred_at'] === 'string' ? taskNode.properties['occurred_at'] : undefined;
        const actor = typeof taskNode.properties['author'] === 'string' ? taskNode.properties['author'] : undefined;
        activities.push({
          task_urn: taskNode.urn,
          operation,
          status,
          ...(occurredAt ? { occurred_at: occurredAt } : {}),
          ...(actor ? { actor } : {}),
          used,
          associated_agents,
        });
        replay.push({
          ...(occurredAt ? { occurred_at: occurredAt } : {}),
          operation,
          ...(actor ? { actor } : {}),
          version_urn: versionUrn,
          status,
        });
      }
      activities.sort((a, b) => (a.occurred_at ?? '').localeCompare(b.occurred_at ?? ''));
      derivation_chain.push({
        version_urn: versionUrn,
        was_derived_from: derivedFromByUrn.get(versionUrn) ?? [],
        activities,
      });
    }
    replay.sort((a, b) => (a.occurred_at ?? '').localeCompare(b.occurred_at ?? ''));

    return {
      entity: { urn: start.urn, entity_type: start.entity_type },
      derivation_chain,
      replay,
    };
  }

  async getArtifact(
    input: RegistryGetArtifactInput,
    _ctx: ExecutionContext,
  ): Promise<RegistryGetArtifactOutput> {
    const sha256 = input.sha256 ?? parseArtifactSha256(input.artifact_urn ?? '');
    if (!sha256) {
      return { sha256: '', size_bytes: 0, content: '', content_truncated: false, digest_verified: false };
    }

    let got;
    try {
      got = await this.deps.cas.getBySha256(sha256);
    } catch (err) {
      if (err instanceof CasIntegrityError) {
        throw new DomainError({
          code: ErrorCode.RegistryArtifactDigestMismatch,
          httpStatus: 409,
          safeMessage: 'Artifact failed its digest verification.',
        });
      }
      throw err;
    }
    if (!got) {
      return { sha256, size_bytes: 0, content: '', content_truncated: false, digest_verified: false };
    }

    await this.readGate.assertArtifactReadable({ artifact_urn: artifactUrn(sha256) });

    const content = decodeUtf8(got.bytes);
    return {
      sha256,
      size_bytes: got.record.size_bytes,
      content,
      content_truncated: false,
      digest_verified: got.digest_verified,
    };
  }

  async search(input: RegistrySearchInput, _ctx: ExecutionContext): Promise<RegistrySearchOutput> {
    const needle = input.query.toLowerCase();
    const limit = input.limit ?? 20;
    const wantSkills = input.type === 'skill' || input.type === 'all';
    const wantAgents = input.type === 'agent' || input.type === 'all';

    const skills: RegistrySearchOutput['skills'] = [];
    const agents: RegistrySearchOutput['agents'] = [];

    if (wantSkills) {
      const nodes = await this.deps.graph.listNodesByType('SKILL', {});
      for (const n of nodes) {
        if (skills.length >= limit) break;
        const key = String(n.properties['skill_key'] ?? n.urn);
        const displayName = typeof n.properties['display_name'] === 'string' ? n.properties['display_name'] : undefined;
        const description = typeof n.properties['description'] === 'string' ? n.properties['description'] : undefined;
        const sourcePath = typeof n.properties['source_path'] === 'string' ? n.properties['source_path'] : undefined;
        const activeVersion = typeof n.properties['active_version'] === 'number' ? n.properties['active_version'] : undefined;
        const certStatus = typeof n.properties['certification_status'] === 'string' ? n.properties['certification_status'] : undefined;
        const haystack = [n.urn, key, displayName, description, sourcePath].filter(Boolean).join(' ').toLowerCase();
        if (!haystack.includes(needle)) continue;
        skills.push({
          skill_urn: n.urn,
          skill_key: key,
          ...(displayName ? { display_name: displayName } : {}),
          ...(description ? { description } : {}),
          ...(sourcePath ? { source_path: sourcePath } : {}),
          ...(activeVersion ? { active_version: activeVersion } : {}),
          ...(certStatus ? { certification_status: certStatus } : {}),
        });
      }
    }

    if (wantAgents) {
      const nodes = await this.deps.graph.listNodesByType('AGENT', {});
      for (const n of nodes) {
        if (agents.length >= limit) break;
        const key = String(n.properties['agent_key'] ?? n.urn);
        const harnessName = typeof n.properties['harness_name'] === 'string' ? n.properties['harness_name'] : undefined;
        const displayName = typeof n.properties['display_name'] === 'string' ? n.properties['display_name'] : undefined;
        const description = typeof n.properties['description'] === 'string' ? n.properties['description'] : undefined;
        const sourcePath = typeof n.properties['source_path'] === 'string' ? n.properties['source_path'] : undefined;
        const haystack = [n.urn, key, harnessName, displayName, description, sourcePath].filter(Boolean).join(' ').toLowerCase();
        if (!haystack.includes(needle)) continue;
        agents.push({
          agent_urn: n.urn,
          agent_key: key,
          ...(harnessName ? { harness_name: harnessName } : {}),
          ...(displayName ? { display_name: displayName } : {}),
          ...(description ? { description } : {}),
          ...(sourcePath ? { source_path: sourcePath } : {}),
        });
      }
    }

    return { query: input.query, skills, agents };
  }
}

const ARTIFACT_SHA256_PATTERN = /^[0-9a-f]{64}$/;

function parseArtifactSha256(artifactUrn: string): string | undefined {
  const prefix = 'urn:sg:artifact:sha256:';
  if (!artifactUrn.startsWith(prefix)) return undefined;
  const sha256 = artifactUrn.slice(prefix.length);
  return ARTIFACT_SHA256_PATTERN.test(sha256) ? sha256 : undefined;
}

function parseHarnessName(harnessUrn: string): string | undefined {
  const prefix = 'urn:sg:harness:';
  return harnessUrn.startsWith(prefix) ? harnessUrn.slice(prefix.length) : undefined;
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}


function activeVersionUrn(properties: Record<string, unknown>): string | undefined {
  const value = properties['active_version_urn'];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
