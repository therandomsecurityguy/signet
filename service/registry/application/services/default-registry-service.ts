import { createHash } from 'node:crypto';
import { createPublicKey, randomUUID, verify as verifySignature } from 'node:crypto';

import { CasIntegrityError, type ArtifactStore } from '../../domain/signet/db/graph/freeform/registry/artifact-store.js';
import type { GraphStore } from '../../domain/signet/db/graph/freeform/registry/graph-store.js';
import {
  agentUrn,
  agentVersionUrn,
  artifactUrn,
  deFactoTermUrn,
  harnessUrn,
  provAgentUrn,
  publicKeyUrn,
  skillUrn,
  skillVersionUrn,
  taskUrn,
  transparencyGossipEventUrn,
  transparencyLogUrn,
  transparencyWitnessUrn,
} from '../../domain/signet/db/graph/freeform/registry/urn.js';
import { RegistryCoreError } from '../errors/registry-core-error.js';
import {
  JCS_CANONICALIZATION_ALGORITHM,
  canonicalJsonString,
  canonicalizeWith,
  resolveCanonicalizationAlgorithm,
} from './canonical-json.js';
import {
  parseShapeDocument,
  type ShapeDocument,
  type ValidationViolation,
} from './shacl-like-validator.js';
import {
  SHACL_VALIDATOR_ID,
  resolveShaclEngine,
  resolveTurtleShapesEngine,
  validatePublicationGraphWithShacl,
  validatePublicationGraphWithTurtleShapes,
} from './shacl-publication-validation.js';
import type { ShaclExecutionPort } from './shacl-execution-port.js';
import { BUILTIN_GRAPH_SHAPE_SHA256, BUILTIN_GRAPH_SHAPE_TURTLE } from './builtin-graph-shape.js';
import { parsePolicyPackageEnvelope } from './policy-package-envelope.js';
import { canonicalizeProvenance } from './provenance-export.js';
import {
  canonicalizeValidationReport,
  projectValidationReportToJsonLd,
  type ValidationReportLayer,
} from './validation-report-export.js';
import {
  parseOntologyDocument,
  validateCapabilityClaims,
  type OntologyDocument,
} from './ontology-validator.js';
import { computeMerkleRoot, generateInclusionProof } from './merkle-log.js';
import { computeCanonicalRdf, projectPublicationGraphToNQuads } from './rdf-projection.js';
import { verifyKeylessBundle, type KeylessTrustPolicy } from './keyless-verification.js';
import {
  keyHintForPublicKeyPem,
  parseCheckpointNote,
  rfc6962LeafHashBytes,
  verifyRfc6962Inclusion,
  verifySignedNote,
} from './transparency-notes.js';
import {
  SemanticCompileError,
  compileMarkdownSkill,
  compileToolManifest,
  mapClaimsToOntology,
} from './semantic-compiler.js';
import type { LlmValidationResult, LlmValidator } from './llm-validator.js';
import type {
  CreateSkillDraftInput,
  CreateAgentDraftInput,
  CreateAgentInput,
  CreateResult,
  CreateSkillInput,
  RegistryAgentDetails,
  RegistryAgentVersionDetails,
  RegistryArtifactDetails,
  RegistryArtifactBytes,
  RegistryArtifactReference,
  RegistryAttestationInput,
  RegistryAttestationRecord,
  RegistryDetachedSignatureInput,
  RegistryDetachedSignatureRecord,
  RegistryGovernanceInput,
  RegistryLifecycleStatus,
  RegistryOperationKind,
  RegistryOperationResult,
  RegistryPublicationVerification,
  RegistrySkillVersionDetails,
  RegistryService,
  RegistrySkillDetails,
  RegistrySkillRefInput,
  SkillVersionOperationInput,
  AgentVersionOperationInput,
  RegistryTaskDetails,
} from '../ports/registry-service.js';

type TransparencyAppendIntentPublisher = {
  publishAppendIntent(input: {
    source_urn: string;
    source_type: 'publication_envelope' | 'governance_event';
    digest: string;
    digest_algorithm: string;
    content_type?: string;
    note?: string;
    payload?: Record<string, unknown>;
  }): Promise<import('../ports/registry-service.js').RegistryTransparencyAppendIntentRef>;
};

export class DefaultRegistryService implements RegistryService {
  constructor(
    private readonly deps: {
      graph: GraphStore;
      cas: ArtifactStore;
      appendIntentPublisher?: TransparencyAppendIntentPublisher;
      transparencyReconciler?: {
        public_key_pem: string;
        fetchLogEntry(input: { log_id: string; entry_index: number }): Promise<Record<string, unknown>>;
      };
      keyless?: KeylessTrustPolicy;
      llmValidator?: LlmValidator;
      /**
       * W3C SHACL execution engine for publication validation; defaults to
       * the in-process rdf-validate-shacl adapter. Injectable so tests can
       * pin a fake engine and deployments can swap engines without touching
       * validation orchestration.
       */
      shaclExecution?: ShaclExecutionPort;
    },
  ) {}

  async listTrustedPublicKeys(input: {
    limit?: number;
    offset?: number;
  }): Promise<{ public_keys: import('../ports/registry-service.js').RegistryTrustedPublicKeySummary[] }> {
    const nodes = await this.deps.graph.listNodesByType('PUBLIC_KEY', {
      ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
      ...(typeof input.offset === 'number' ? { offset: input.offset } : {}),
    });
    return {
      public_keys: nodes.map((node) => ({
        key_urn: node.urn,
        key_ref: String(node.properties['key_ref'] ?? node.urn),
        algorithm: String(node.properties['algorithm'] ?? 'unknown'),
        ...(typeof node.properties['trust_status'] === 'string'
          ? { trust_status: node.properties['trust_status'] as string }
          : {}),
        ...(typeof node.properties['owner'] === 'string' ? { owner: node.properties['owner'] as string } : {}),
      })),
    };
  }

  async getTrustedPublicKey(input: { key_ref: string }): Promise<import('../ports/registry-service.js').RegistryTrustedPublicKey | null> {
    const node = await this.deps.graph.getNode(publicKeyUrn(input.key_ref));
    if (!node || node.entity_type !== 'PUBLIC_KEY') return null;
    const artifactEdges = await this.deps.graph.listEdgesFrom(node.urn, 'sg:definedBy');
    return {
      public_key: {
        urn: node.urn,
        properties: node.properties,
      },
      artifacts: artifactEdges.map((edge) => ({
        artifact_urn: edge.to_urn,
        ...(toOptionalStringProp('sha256', parseArtifactSha256(edge.to_urn))),
      })),
    };
  }

  async revokeTrustedPublicKey(input: import('../ports/registry-service.js').RevokeTrustedPublicKeyInput) {
    const existing = await this.getTrustedPublicKey({ key_ref: input.key_ref });
    if (!existing) {
      throw new RegistryCoreError('PUBLIC_KEY_NOT_FOUND', 'Trusted public key not found.');
    }
    const properties = existing.public_key.properties;
    if (stringOrUndefined(properties['trust_status']) === 'revoked') {
      return existing;
    }
    await this.deps.graph.upsertNode({
      urn: existing.public_key.urn,
      entity_type: 'PUBLIC_KEY',
      properties: {
        ...properties,
        trust_status: 'revoked',
        revoked_at: nowIso(),
        revoked_by: input.author,
        ...(input.reason ? { revoked_reason: input.reason } : {}),
      },
    });
    const updated = await this.getTrustedPublicKey({ key_ref: input.key_ref });
    if (!updated) {
      throw new RegistryCoreError('PUBLIC_KEY_NOT_FOUND', 'Trusted public key not found after revoke.');
    }
    return updated;
  }

  async createPolicyPackage(
    input: import('../ports/registry-service.js').CreatePolicyPackageInput,
  ): Promise<CreateResult<import('../ports/registry-service.js').RegistryPolicyPackageDetails>> {
    const gateInputs = {
      require_human_review: input.require_human_review,
      require_validation: input.require_validation,
      require_signature: input.require_signature,
      require_trusted_publisher: input.require_trusted_publisher,
      require_build_provenance: input.require_build_provenance,
      require_sbom: input.require_sbom,
    };
    const gateProvided = Object.values(gateInputs).some((value) => value !== undefined);
    if (gateProvided && input.shapes_format !== 'shacl-turtle') {
      throw new RegistryCoreError(
        'POLICY_PACKAGE_INVALID',
        'Policy gate fields (require_*) belong inside the shapes document for legacy JSON policies; top-level gates are only accepted with shapes_format "shacl-turtle".',
      );
    }

    let envelope: Record<string, unknown>;
    try {
      const parsed = parsePolicyPackageEnvelope({
        ...(input.shapes_format ? { shapes_format: input.shapes_format } : {}),
        shapes: input.shapes,
        ...(input.shapes_format === 'shacl-turtle'
          ? Object.fromEntries(Object.entries(gateInputs).filter(([, value]) => value !== undefined))
          : {}),
      });
      envelope =
        parsed.shapes_format === 'shacl-turtle'
          ? { policy_version: input.policy_version, shapes_format: 'shacl-turtle', shapes: parsed.shapes, ...parsed.gates }
          : { policy_version: input.policy_version, shapes: parsed.document };
    } catch (err) {
      throw new RegistryCoreError(
        'POLICY_PACKAGE_INVALID',
        err instanceof Error ? err.message : 'Policy package shapes are invalid.',
      );
    }

    const content = canonicalJsonString(envelope);
    const artifact = await this.deps.cas.put({
      bytes: Buffer.from(content, 'utf8'),
      media_type: 'application/json',
      original_path: `policy-packages/${sanitizePathSegment(input.policy_version)}.json`,
    });

    const existing = await this.findPolicyPackageNode(input.policy_version);
    if (existing) {
      if (stringOrUndefined(existing.properties['sha256']) === artifact.sha256) {
        return { value: await this.toPolicyPackageDetails(existing), created: false };
      }
      throw new RegistryCoreError(
        'POLICY_PACKAGE_CONFLICT',
        `Policy package already exists with different shapes: ${input.policy_version}`,
      );
    }

    const artifactNodeUrn = artifactUrn(artifact.sha256);
    await this.deps.graph.upsertNode({
      urn: artifactNodeUrn,
      entity_type: 'ARTIFACT',
      properties: {
        sha256: artifact.sha256,
        size_bytes: artifact.size_bytes,
        media_type: artifact.media_type,
        original_path: artifact.original_path,
        governance_role: 'policy_package',
        policy_version: input.policy_version,
        created_by: input.author,
        created_at: nowIso(),
        ...(input.description ? { description: input.description } : {}),
      },
    });
    const node = await this.deps.graph.getNode(artifactNodeUrn);
    if (!node) {
      throw new RegistryCoreError('POLICY_PACKAGE_CREATE_FAILED', 'Failed to create policy package.');
    }
    return { value: await this.toPolicyPackageDetails(node), created: true };
  }

  async listPolicyPackages(): Promise<{ policy_packages: import('../ports/registry-service.js').RegistryPolicyPackageDetails[] }> {
    const nodes = await this.deps.graph.listNodesByType('ARTIFACT');
    const packages = [];
    for (const node of nodes) {
      if (node.properties['governance_role'] !== 'policy_package') continue;
      if (!stringOrUndefined(node.properties['policy_version'])) continue;
      packages.push(await this.toPolicyPackageDetails(node));
    }
    packages.sort((left, right) => left.policy_version.localeCompare(right.policy_version));
    return { policy_packages: packages };
  }

  async getPolicyPackage(input: { policy_version: string }): Promise<import('../ports/registry-service.js').RegistryPolicyPackageDetails | null> {
    const node = await this.findPolicyPackageNode(input.policy_version);
    return node ? await this.toPolicyPackageDetails(node) : null;
  }

  private async findPolicyPackageNode(policyVersion: string) {
    const nodes = await this.deps.graph.listNodesByType('ARTIFACT');
    return (
      nodes.find(
        (node) =>
          node.properties['governance_role'] === 'policy_package' &&
          node.properties['policy_version'] === policyVersion,
      ) ?? null
    );
  }

  private async toPolicyPackageDetails(
    node: { urn: string; properties: Record<string, unknown> },
  ): Promise<import('../ports/registry-service.js').RegistryPolicyPackageDetails> {
    const sha256 = stringOrUndefined(node.properties['sha256']) ?? parseArtifactSha256(node.urn) ?? '';
    let shapes: unknown = null;
    let shapes_format: import('../ports/registry-service.js').PolicyShapesFormat = 'legacy-json-v1';
    const stored = await this.deps.cas.getBySha256(sha256);
    if (stored) {
      try {
        const parsed = parsePolicyPackageEnvelope(
          JSON.parse(new TextDecoder('utf-8', { fatal: false }).decode(stored.bytes)),
        );
        shapes_format = parsed.shapes_format;
        shapes = parsed.shapes;
      } catch {
        shapes = null;
      }
    }
    return {
      artifact_urn: node.urn,
      sha256,
      policy_version: stringOrUndefined(node.properties['policy_version']) ?? '',
      created_by: stringOrUndefined(node.properties['created_by']) ?? '',
      created_at: stringOrUndefined(node.properties['created_at']) ?? '',
      ...(stringOrUndefined(node.properties['description'])
        ? { description: String(node.properties['description']) }
        : {}),
      shapes_format,
      shapes,
    };
  }

  async createOntologyPackage(
    input: import('../ports/registry-service.js').CreateOntologyPackageInput,
  ): Promise<CreateResult<import('../ports/registry-service.js').RegistryOntologyPackageDetails>> {
    let document;
    try {
      document = parseOntologyDocument(input.ontology);
    } catch (err) {
      throw new RegistryCoreError(
        'ONTOLOGY_PACKAGE_INVALID',
        err instanceof Error ? err.message : 'Ontology package document is invalid.',
      );
    }

    const content = canonicalJsonString({
      ontology_version: input.ontology_version,
      ontology: document,
    });
    const artifact = await this.deps.cas.put({
      bytes: Buffer.from(content, 'utf8'),
      media_type: 'application/json',
      original_path: `ontology-packages/${sanitizePathSegment(input.ontology_version)}.json`,
    });

    const existing = await this.findOntologyPackageNode(input.ontology_version);
    if (existing) {
      if (stringOrUndefined(existing.properties['sha256']) === artifact.sha256) {
        return { value: await this.toOntologyPackageDetails(existing), created: false };
      }
      throw new RegistryCoreError(
        'ONTOLOGY_PACKAGE_CONFLICT',
        `Ontology package already exists with different content: ${input.ontology_version}`,
      );
    }

    const artifactNodeUrn = artifactUrn(artifact.sha256);
    await this.deps.graph.upsertNode({
      urn: artifactNodeUrn,
      entity_type: 'ARTIFACT',
      properties: {
        sha256: artifact.sha256,
        size_bytes: artifact.size_bytes,
        media_type: artifact.media_type,
        original_path: artifact.original_path,
        governance_role: 'ontology_package',
        ontology_version: input.ontology_version,
        ontology_kind: document.kind,
        created_by: input.author,
        created_at: nowIso(),
        ...(input.description ? { description: input.description } : {}),
      },
    });
    const node = await this.deps.graph.getNode(artifactNodeUrn);
    if (!node) {
      throw new RegistryCoreError('ONTOLOGY_PACKAGE_CREATE_FAILED', 'Failed to create ontology package.');
    }
    return { value: await this.toOntologyPackageDetails(node), created: true };
  }

  async listOntologyPackages(): Promise<{ ontology_packages: import('../ports/registry-service.js').RegistryOntologyPackageDetails[] }> {
    const nodes = await this.deps.graph.listNodesByType('ARTIFACT');
    const packages = [];
    for (const node of nodes) {
      if (node.properties['governance_role'] !== 'ontology_package') continue;
      if (!stringOrUndefined(node.properties['ontology_version'])) continue;
      packages.push(await this.toOntologyPackageDetails(node));
    }
    packages.sort((left, right) => left.ontology_version.localeCompare(right.ontology_version));
    return { ontology_packages: packages };
  }

  async getOntologyPackage(input: { ontology_version: string }): Promise<import('../ports/registry-service.js').RegistryOntologyPackageDetails | null> {
    const node = await this.findOntologyPackageNode(input.ontology_version);
    return node ? await this.toOntologyPackageDetails(node) : null;
  }

  private async findOntologyPackageNode(ontologyVersion: string) {
    const nodes = await this.deps.graph.listNodesByType('ARTIFACT');
    return (
      nodes.find(
        (node) =>
          node.properties['governance_role'] === 'ontology_package' &&
          node.properties['ontology_version'] === ontologyVersion,
      ) ?? null
    );
  }

  private async toOntologyPackageDetails(
    node: { urn: string; properties: Record<string, unknown> },
  ): Promise<import('../ports/registry-service.js').RegistryOntologyPackageDetails> {
    const sha256 = stringOrUndefined(node.properties['sha256']) ?? parseArtifactSha256(node.urn) ?? '';
    let ontology: unknown = null;
    const stored = await this.deps.cas.getBySha256(sha256);
    if (stored) {
      try {
        ontology =
          (JSON.parse(new TextDecoder('utf-8', { fatal: false }).decode(stored.bytes)) as { ontology?: unknown }).ontology ??
          null;
      } catch {
        ontology = null;
      }
    }
    const kind = node.properties['ontology_kind'];
    return {
      artifact_urn: node.urn,
      sha256,
      ontology_version: stringOrUndefined(node.properties['ontology_version']) ?? '',
      ontology_kind: kind === 'registry_shape' ? 'registry_shape' : 'skill_area',
      created_by: stringOrUndefined(node.properties['created_by']) ?? '',
      created_at: stringOrUndefined(node.properties['created_at']) ?? '',
      ...(stringOrUndefined(node.properties['description'])
        ? { description: String(node.properties['description']) }
        : {}),
      ontology,
    };
  }

  async createTrustedPublicKey(input: import('../ports/registry-service.js').CreateTrustedPublicKeyInput): Promise<CreateResult<import('../ports/registry-service.js').RegistryTrustedPublicKey>> {
    const existing = await this.getTrustedPublicKey({ key_ref: input.key_ref });
    const normalizedPem = normalizePem(input.public_key_pem);
    if (existing) {
      const existingArtifact = existing.artifacts[0];
      const existingSha = existingArtifact?.sha256;
      const requestedSha = sha256Hex(Buffer.from(normalizedPem, 'utf8'));
      const existingProperties = existing.public_key.properties;
      if (
        existingSha === requestedSha &&
        stringOrUndefined(existingProperties['algorithm']) === input.algorithm &&
        stringOrUndefined(existingProperties['owner']) === input.owner &&
        stringOrUndefined(existingProperties['trust_scope']) === input.trust_scope &&
        stringOrUndefined(existingProperties['transparency_log_ref']) === input.transparency_log_ref &&
        stringOrUndefined(existingProperties['inclusion_proof_ref']) === input.inclusion_proof_ref &&
        stringOrUndefined(existingProperties['supersedes_key_ref']) === input.supersedes_key_ref &&
        stringOrUndefined(existingProperties['valid_from']) === input.valid_from &&
        stringOrUndefined(existingProperties['valid_to']) === input.valid_to &&
        stringOrUndefined(existingProperties['trust_status']) === 'trusted'
      ) {
        return { value: existing, created: false };
      }
      throw new RegistryCoreError('PUBLIC_KEY_CREATE_CONFLICT', 'Trusted public key already exists with different state.');
    }

    try {
      assertPublicKeyUsable(normalizedPem);
    } catch {
      throw new RegistryCoreError('PUBLIC_KEY_INVALID', 'Trusted public key PEM is not usable.');
    }
    const artifact = await this.deps.cas.put({
      bytes: Buffer.from(normalizedPem, 'utf8'),
      media_type: 'application/x-pem-file',
      original_path: `trusted-keys/${sanitizePathSegment(input.key_ref)}.pem`,
    });
    const artifactNodeUrn = artifactUrn(artifact.sha256);
    const keyUrn = publicKeyUrn(input.key_ref);

    await this.deps.graph.upsertNode({
      urn: artifactNodeUrn,
      entity_type: 'ARTIFACT',
      properties: {
        sha256: artifact.sha256,
        size_bytes: artifact.size_bytes,
        media_type: artifact.media_type,
        original_path: artifact.original_path,
        governance_role: 'trusted_public_key',
      },
    });
    await this.deps.graph.upsertNode({
      urn: keyUrn,
      entity_type: 'PUBLIC_KEY',
      properties: {
        key_ref: input.key_ref,
        algorithm: input.algorithm,
        trust_status: 'trusted',
        created_at: nowIso(),
        ...(input.owner ? { owner: input.owner } : {}),
        ...(input.trust_scope ? { trust_scope: input.trust_scope } : {}),
        ...(input.transparency_log_ref ? { transparency_log_ref: input.transparency_log_ref } : {}),
        ...(input.inclusion_proof_ref ? { inclusion_proof_ref: input.inclusion_proof_ref } : {}),
        ...(input.supersedes_key_ref ? { supersedes_key_ref: input.supersedes_key_ref } : {}),
        ...(input.valid_from ? { valid_from: input.valid_from } : {}),
        ...(input.valid_to ? { valid_to: input.valid_to } : {}),
      },
    });
    await this.deps.graph.upsertEdge({
      from_urn: keyUrn,
      to_urn: artifactNodeUrn,
      predicate: 'sg:definedBy',
      properties: {},
    });
    if (input.supersedes_key_ref) {
      const previous = await this.getTrustedPublicKey({ key_ref: input.supersedes_key_ref });
      if (!previous) {
        throw new RegistryCoreError('PUBLIC_KEY_NOT_FOUND', 'Superseded trusted public key not found.');
      }
      await this.deps.graph.upsertNode({
        urn: previous.public_key.urn,
        entity_type: 'PUBLIC_KEY',
        properties: {
          ...previous.public_key.properties,
          trust_status: 'superseded',
          superseded_by_key_ref: input.key_ref,
          superseded_at: nowIso(),
          ...(stringOrUndefined(previous.public_key.properties['valid_to']) ? {} : { valid_to: nowIso() }),
        },
      });
      await this.deps.graph.upsertEdge({
        from_urn: keyUrn,
        to_urn: previous.public_key.urn,
        predicate: 'sg:supersedesKey',
        properties: {},
      });
    }

    const created = await this.getTrustedPublicKey({ key_ref: input.key_ref });
    if (!created) {
      throw new RegistryCoreError('PUBLIC_KEY_CREATE_FAILED', 'Failed to create trusted public key.');
    }
    return { value: created, created: true };
  }

  async listTransparencyLogs(input: {
    limit?: number;
    offset?: number;
  }): Promise<{ transparency_logs: import('../ports/registry-service.js').RegistryTransparencyLogSummary[] }> {
    const nodes = await this.deps.graph.listNodesByType('TRANSPARENCY_LOG', {
      ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
      ...(typeof input.offset === 'number' ? { offset: input.offset } : {}),
    });
    return {
      transparency_logs: nodes.map((node) => ({
        log_urn: node.urn,
        log_id: String(node.properties['log_id'] ?? node.urn),
        origin: String(node.properties['origin'] ?? ''),
        checkpoint_key_ref: String(node.properties['checkpoint_key_ref'] ?? ''),
        ...(typeof node.properties['trust_status'] === 'string'
          ? { trust_status: node.properties['trust_status'] as string }
          : {}),
      })),
    };
  }

  async getTransparencyLog(input: { log_id: string }): Promise<import('../ports/registry-service.js').RegistryTransparencyLogDetails | null> {
    const node = await this.deps.graph.getNode(transparencyLogUrn(input.log_id));
    if (!node || node.entity_type !== 'TRANSPARENCY_LOG') return null;
    const keyEdges = await this.deps.graph.listEdgesFrom(node.urn, 'sg:usesCheckpointKey');
    const checkpointKeyUrn = keyEdges[0]?.to_urn;
    const checkpointKey = checkpointKeyUrn ? await this.deps.graph.getNode(checkpointKeyUrn) : null;
    const witnessEdges = await this.deps.graph.listEdgesFrom(node.urn, 'sg:trustedByWitness');
    const witnessQuorumRequired = numberOrUndefined(node.properties['witness_quorum']) ?? 0;
    const currentCheckpointArtifactUrn = stringOrUndefined(node.properties['current_checkpoint_artifact_urn']);
    const currentCheckpoint = currentCheckpointArtifactUrn
      ? await this.getTransparencyCheckpointDetails(currentCheckpointArtifactUrn, {
          witness_quorum_required: witnessQuorumRequired,
        })
      : null;
    const gossipEvents = await this.listTransparencyGossipEvents(node.urn);
    const checkpointEdges = await this.deps.graph.listEdgesFrom(node.urn, 'sg:hasCheckpoint');
    const checkpoints = (
      await Promise.all(
        checkpointEdges.map((edge) =>
          this.getTransparencyCheckpointDetails(edge.to_urn, {
            witness_quorum_required: witnessQuorumRequired,
          }),
        ),
      )
    ).filter((value): value is import('../ports/registry-service.js').RegistryTransparencyCheckpointDetails => Boolean(value))
      .sort((left, right) => left.tree_size - right.tree_size);
    return {
      transparency_log: {
        urn: node.urn,
        properties: node.properties,
      },
      ...(checkpointKey && checkpointKey.entity_type === 'PUBLIC_KEY'
        ? {
            checkpoint_key: {
              key_urn: checkpointKey.urn,
              key_ref: String(checkpointKey.properties['key_ref'] ?? checkpointKey.urn),
            },
          }
        : {}),
      ...(currentCheckpoint ? { current_checkpoint: currentCheckpoint } : {}),
      checkpoints,
      witnesses: (
        await Promise.all(
          witnessEdges.map(async (edge) => {
            const witness = await this.deps.graph.getNode(edge.to_urn);
            if (!witness || witness.entity_type !== 'TRANSPARENCY_WITNESS') return null;
            return {
              witness_urn: witness.urn,
              witness_id: String(witness.properties['witness_id'] ?? witness.urn),
              key_ref: String(witness.properties['key_ref'] ?? ''),
              ...(typeof witness.properties['trust_status'] === 'string'
                ? { trust_status: witness.properties['trust_status'] as string }
                : {}),
            };
          }),
        )
      ).filter((value): value is import('../ports/registry-service.js').RegistryTransparencyWitnessSummary => Boolean(value)),
      gossip_events: gossipEvents,
    };
  }

  async createTransparencyLog(input: import('../ports/registry-service.js').CreateTransparencyLogInput): Promise<CreateResult<import('../ports/registry-service.js').RegistryTransparencyLogDetails>> {
    const existing = await this.getTransparencyLog({ log_id: input.log_id });
    if (existing) {
      const properties = existing.transparency_log.properties;
      if (
        stringOrUndefined(properties['origin']) === input.origin &&
        stringOrUndefined(properties['checkpoint_key_ref']) === input.checkpoint_key_ref &&
        stringOrUndefined(properties['log_type']) === input.log_type &&
        stringOrUndefined(properties['trust_scope']) === input.trust_scope &&
        stringOrUndefined(properties['valid_from']) === input.valid_from &&
        stringOrUndefined(properties['valid_to']) === input.valid_to &&
        numberOrUndefined(properties['witness_quorum']) === input.witness_quorum &&
        stringOrUndefined(properties['trust_status']) === 'trusted'
      ) {
        return { value: existing, created: false };
      }
      throw new RegistryCoreError('TRANSPARENCY_LOG_CREATE_CONFLICT', 'Transparency log already exists with different state.');
    }
    const checkpointKey = await this.resolveTrustedPublicKeyMaterial(input.checkpoint_key_ref);
    if (!checkpointKey) {
      throw new RegistryCoreError('TRANSPARENCY_LOG_INVALID_CHECKPOINT_KEY', 'Checkpoint verification key must exist and be trusted.');
    }
    const logUrn = transparencyLogUrn(input.log_id);
    await this.deps.graph.upsertNode({
      urn: logUrn,
      entity_type: 'TRANSPARENCY_LOG',
      properties: {
        log_id: input.log_id,
        origin: input.origin,
        checkpoint_key_ref: input.checkpoint_key_ref,
        trust_status: 'trusted',
        created_at: nowIso(),
        ...(input.log_type ? { log_type: input.log_type } : {}),
        ...(input.trust_scope ? { trust_scope: input.trust_scope } : {}),
        ...(input.valid_from ? { valid_from: input.valid_from } : {}),
        ...(input.valid_to ? { valid_to: input.valid_to } : {}),
        ...(typeof input.witness_quorum === 'number' ? { witness_quorum: input.witness_quorum } : {}),
      },
    });
    await this.deps.graph.upsertEdge({
      from_urn: logUrn,
      to_urn: checkpointKey.key_urn,
      predicate: 'sg:usesCheckpointKey',
      properties: {},
    });
    const created = await this.getTransparencyLog({ log_id: input.log_id });
    if (!created) {
      throw new RegistryCoreError('TRANSPARENCY_LOG_CREATE_FAILED', 'Failed to create transparency log.');
    }
    return { value: created, created: true };
  }

  async createTransparencyWitness(input: import('../ports/registry-service.js').CreateTransparencyWitnessInput): Promise<CreateResult<import('../ports/registry-service.js').RegistryTransparencyLogDetails>> {
    const log = await this.getTransparencyLog({ log_id: input.log_id });
    if (!log) throw new RegistryCoreError('TRANSPARENCY_LOG_NOT_FOUND', 'Transparency log not found.');
    const key = await this.resolveTrustedPublicKeyMaterial(input.key_ref);
    if (!key) {
      throw new RegistryCoreError('TRANSPARENCY_WITNESS_INVALID_KEY', 'Witness verification key must exist and be trusted.');
    }
    const witnessUrn = transparencyWitnessUrn(input.witness_id);
    const existing = await this.deps.graph.getNode(witnessUrn);
    if (existing) {
      if (
        stringOrUndefined(existing.properties['key_ref']) !== input.key_ref ||
        stringOrUndefined(existing.properties['witness_type']) !== input.witness_type ||
        stringOrUndefined(existing.properties['valid_from']) !== input.valid_from ||
        stringOrUndefined(existing.properties['valid_to']) !== input.valid_to
      ) {
        throw new RegistryCoreError('TRANSPARENCY_WITNESS_CREATE_CONFLICT', 'Transparency witness already exists with different state.');
      }
    } else {
      await this.deps.graph.upsertNode({
        urn: witnessUrn,
        entity_type: 'TRANSPARENCY_WITNESS',
        properties: {
          witness_id: input.witness_id,
          key_ref: input.key_ref,
          trust_status: 'trusted',
          created_at: nowIso(),
          ...(input.witness_type ? { witness_type: input.witness_type } : {}),
          ...(input.valid_from ? { valid_from: input.valid_from } : {}),
          ...(input.valid_to ? { valid_to: input.valid_to } : {}),
        },
      });
      await this.deps.graph.upsertEdge({
        from_urn: witnessUrn,
        to_urn: key.key_urn,
        predicate: 'sg:usesWitnessKey',
        properties: {},
      });
    }
    await this.deps.graph.upsertEdge({
      from_urn: log.transparency_log.urn,
      to_urn: witnessUrn,
      predicate: 'sg:trustedByWitness',
      properties: {},
    });
    const updated = await this.getTransparencyLog({ log_id: input.log_id });
    if (!updated) throw new RegistryCoreError('TRANSPARENCY_LOG_NOT_FOUND', 'Transparency log not found after witness attach.');
    return { value: updated, created: !existing };
  }

  async createTransparencyCheckpoint(input: import('../ports/registry-service.js').CreateTransparencyCheckpointInput) {
    const log = await this.getTransparencyLog({ log_id: input.log_id });
    if (!log) throw new RegistryCoreError('TRANSPARENCY_LOG_NOT_FOUND', 'Transparency log not found.');
    const normalizedCheckpoint = normalizeCheckpointSubmission(input);
    const occurredAt = nowIso();
    const checkpointFields = parseCheckpointBody(normalizedCheckpoint.checkpoint_body);
    if (!checkpointFields) {
      throw new RegistryCoreError('TRANSPARENCY_CHECKPOINT_INVALID', 'Checkpoint body is invalid.');
    }
    if (checkpointFields.origin !== stringOrUndefined(log.transparency_log.properties['origin'])) {
      throw new RegistryCoreError('TRANSPARENCY_CHECKPOINT_INVALID', 'Checkpoint origin does not match trusted transparency log.');
    }
    const checkpointKeyRef = stringOrUndefined(log.transparency_log.properties['checkpoint_key_ref']);
    const checkpointKey = checkpointKeyRef ? await this.resolveTrustedPublicKeyMaterial(checkpointKeyRef) : null;
    if (!checkpointKey) {
      throw new RegistryCoreError('TRANSPARENCY_LOG_INVALID_CHECKPOINT_KEY', 'Trusted checkpoint key could not be resolved.');
    }
    const checkpointSignatureValid = verifyDetachedSignatureBytes({
      algorithm: checkpointKey.algorithm,
      public_key_pem: checkpointKey.public_key_pem,
      message: normalizedCheckpoint.checkpoint_body,
      signature: normalizedCheckpoint.checkpoint_signature,
    });
    if (!checkpointSignatureValid) {
      throw new RegistryCoreError('TRANSPARENCY_CHECKPOINT_SIGNATURE_INVALID', 'Checkpoint signature is invalid.');
    }

    let appendOnlyVerified = true;
    const current = log.current_checkpoint;
    if (current && checkpointFields.tree_size < current.tree_size) {
      throw new RegistryCoreError('TRANSPARENCY_CHECKPOINT_REGRESSION', 'Checkpoint tree size regressed.');
    }
    if (current && checkpointFields.tree_size > current.tree_size) {
      if (!input.consistency_proof) {
        throw new RegistryCoreError('TRANSPARENCY_CONSISTENCY_PROOF_REQUIRED', 'Consistency proof is required for checkpoint growth.');
      }
      appendOnlyVerified = verifyRfc6962ConsistencyProof({
        old_tree_size: input.consistency_proof.previous_tree_size,
        new_tree_size: checkpointFields.tree_size,
        old_root_hash: input.consistency_proof.previous_root_hash,
        new_root_hash: checkpointFields.root_hash,
        proof_hashes: input.consistency_proof.proof_hashes,
      });
      if (
        input.consistency_proof.previous_tree_size !== current.tree_size ||
        input.consistency_proof.previous_root_hash !== current.root_hash
      ) {
        appendOnlyVerified = false;
      }
      if (!appendOnlyVerified) {
        throw new RegistryCoreError('TRANSPARENCY_CONSISTENCY_PROOF_INVALID', 'Consistency proof is invalid.');
      }
    }

    const checkpointArtifact = await this.deps.cas.put({
      bytes: Buffer.from(
        canonicalJsonString({
          log_id: input.log_id,
          checkpoint_body: normalizedCheckpoint.checkpoint_body,
          checkpoint_signature: normalizedCheckpoint.checkpoint_signature,
          note_format: normalizedCheckpoint.note_format,
          signature_count: normalizedCheckpoint.signature_count,
          signatures: normalizedCheckpoint.signatures,
          ...(normalizedCheckpoint.signed_note ? { signed_note: normalizedCheckpoint.signed_note } : {}),
          ...(normalizedCheckpoint.signed_note_signer
            ? { signed_note_signer: normalizedCheckpoint.signed_note_signer }
            : {}),
          ...(normalizedCheckpoint.signed_note_key_hint
            ? { signed_note_key_hint: normalizedCheckpoint.signed_note_key_hint }
            : {}),
        }),
        'utf8',
      ),
      media_type: 'application/json',
      original_path: `generated/transparency-checkpoint/${sanitizePathSegment(input.log_id)}-${checkpointFields.tree_size}.json`,
    });
    const checkpointArtifactUrn = artifactUrn(checkpointArtifact.sha256);
    await this.deps.graph.upsertNode({
      urn: checkpointArtifactUrn,
      entity_type: 'ARTIFACT',
      properties: {
        sha256: checkpointArtifact.sha256,
        size_bytes: checkpointArtifact.size_bytes,
        media_type: checkpointArtifact.media_type,
        original_path: checkpointArtifact.original_path,
        governance_role: 'transparency_checkpoint',
        log_id: input.log_id,
        tree_size: checkpointFields.tree_size,
        root_hash: checkpointFields.root_hash,
        checkpoint_body: normalizedCheckpoint.checkpoint_body,
        checkpoint_signature: normalizedCheckpoint.checkpoint_signature,
        note_format: normalizedCheckpoint.note_format,
        signed_note_signature_count: normalizedCheckpoint.signature_count,
        signed_note_signatures_json: canonicalJsonString(normalizedCheckpoint.signatures),
        ...(normalizedCheckpoint.signed_note ? { signed_note: normalizedCheckpoint.signed_note } : {}),
        ...(normalizedCheckpoint.signed_note_signer
          ? { signed_note_signer: normalizedCheckpoint.signed_note_signer }
          : {}),
        ...(normalizedCheckpoint.signed_note_key_hint
          ? { signed_note_key_hint: normalizedCheckpoint.signed_note_key_hint }
          : {}),
        occurred_at: occurredAt,
        checkpoint_signature_valid: checkpointSignatureValid,
        append_only_verified: appendOnlyVerified,
      },
    });
    await this.deps.graph.upsertEdge({
      from_urn: log.transparency_log.urn,
      to_urn: checkpointArtifactUrn,
      predicate: 'sg:hasCheckpoint',
      properties: {},
    });

    if (input.consistency_proof) {
      const proofArtifact = await this.deps.cas.put({
        bytes: Buffer.from(
          canonicalJsonString({
            log_id: input.log_id,
            previous_tree_size: input.consistency_proof.previous_tree_size,
            previous_root_hash: input.consistency_proof.previous_root_hash,
            new_tree_size: checkpointFields.tree_size,
            new_root_hash: checkpointFields.root_hash,
            proof_hashes: input.consistency_proof.proof_hashes,
          }),
          'utf8',
        ),
        media_type: 'application/json',
        original_path: `generated/consistency-proof/${sanitizePathSegment(input.log_id)}-${checkpointFields.tree_size}.json`,
      });
      const proofArtifactUrn = artifactUrn(proofArtifact.sha256);
      await this.deps.graph.upsertNode({
        urn: proofArtifactUrn,
        entity_type: 'ARTIFACT',
        properties: {
          sha256: proofArtifact.sha256,
          size_bytes: proofArtifact.size_bytes,
          media_type: proofArtifact.media_type,
          original_path: proofArtifact.original_path,
          governance_role: 'transparency_consistency_proof',
        },
      });
      await this.deps.graph.upsertEdge({
        from_urn: checkpointArtifactUrn,
        to_urn: proofArtifactUrn,
        predicate: 'sg:hasConsistencyProof',
        properties: {},
      });
    }

    if (input.witness_attestations?.length) {
      for (const attestation of input.witness_attestations) {
        const witnessNode = await this.deps.graph.getNode(transparencyWitnessUrn(attestation.witness_id));
        const witnessKeyRef =
          witnessNode && witnessNode.entity_type === 'TRANSPARENCY_WITNESS'
            ? stringOrUndefined(witnessNode.properties['key_ref'])
            : undefined;
        const witnessKey = witnessKeyRef ? await this.resolveTrustedPublicKeyMaterial(witnessKeyRef) : null;
        const signatureValid =
          witnessKey &&
          verifyDetachedSignatureBytes({
            algorithm: witnessKey.algorithm,
            public_key_pem: witnessKey.public_key_pem,
            message: normalizedCheckpoint.checkpoint_body,
            signature: attestation.signature,
          });
        const attestationArtifact = await this.deps.cas.put({
          bytes: Buffer.from(
            canonicalJsonString({
              log_id: input.log_id,
              witness_id: attestation.witness_id,
              checkpoint_artifact_urn: checkpointArtifactUrn,
              checkpoint_body: normalizedCheckpoint.checkpoint_body,
              occurred_at: occurredAt,
              signature: attestation.signature,
              signature_valid: Boolean(signatureValid),
            }),
            'utf8',
          ),
          media_type: 'application/json',
          original_path: `generated/witness-attestation/${sanitizePathSegment(input.log_id)}-${sanitizePathSegment(attestation.witness_id)}-${checkpointFields.tree_size}.json`,
        });
        const attestationArtifactUrn = artifactUrn(attestationArtifact.sha256);
        await this.deps.graph.upsertNode({
          urn: attestationArtifactUrn,
          entity_type: 'ARTIFACT',
          properties: {
            sha256: attestationArtifact.sha256,
            size_bytes: attestationArtifact.size_bytes,
            media_type: attestationArtifact.media_type,
            original_path: attestationArtifact.original_path,
            governance_role: 'transparency_witness_attestation',
            witness_id: attestation.witness_id,
            checkpoint_artifact_urn: checkpointArtifactUrn,
            occurred_at: occurredAt,
            signature: attestation.signature,
            signature_valid: Boolean(signatureValid),
          },
        });
        await this.deps.graph.upsertEdge({
          from_urn: checkpointArtifactUrn,
          to_urn: attestationArtifactUrn,
          predicate: 'sg:hasWitnessAttestation',
          properties: {},
        });
      }
    }

    await this.deps.graph.upsertNode({
      urn: log.transparency_log.urn,
      entity_type: 'TRANSPARENCY_LOG',
      properties: {
        ...log.transparency_log.properties,
        current_checkpoint_artifact_urn: checkpointArtifactUrn,
      },
    });
    const created = await this.getTransparencyCheckpointDetails(checkpointArtifactUrn, {
      witness_quorum_required: numberOrUndefined(log.transparency_log.properties['witness_quorum']) ?? 0,
    });
    if (!created) throw new RegistryCoreError('TRANSPARENCY_CHECKPOINT_INVALID', 'Failed to read stored checkpoint.');
    return created;
  }

  async createTransparencyCheckpointObservation(
    input: import('../ports/registry-service.js').CreateTransparencyCheckpointObservationInput,
  ): Promise<import('../ports/registry-service.js').RegistryTransparencyCheckpointObservation> {
    const log = await this.getTransparencyLog({ log_id: input.log_id });
    if (!log) throw new RegistryCoreError('TRANSPARENCY_LOG_NOT_FOUND', 'Transparency log not found.');
    const normalizedCheckpoint = normalizeCheckpointSubmission(input);
    const checkpointFields = parseCheckpointBody(normalizedCheckpoint.checkpoint_body);
    if (!checkpointFields) throw new RegistryCoreError('TRANSPARENCY_CHECKPOINT_INVALID', 'Checkpoint body is invalid.');
    const checkpointKeyRef = stringOrUndefined(log.transparency_log.properties['checkpoint_key_ref']);
    const checkpointKey = checkpointKeyRef ? await this.resolveTrustedPublicKeyMaterial(checkpointKeyRef) : null;
    if (!checkpointKey) throw new RegistryCoreError('TRANSPARENCY_LOG_INVALID_CHECKPOINT_KEY', 'Trusted checkpoint key could not be resolved.');
    const checkpointSignatureValid = verifyDetachedSignatureBytes({
      algorithm: checkpointKey.algorithm,
      public_key_pem: checkpointKey.public_key_pem,
      message: normalizedCheckpoint.checkpoint_body,
      signature: normalizedCheckpoint.checkpoint_signature,
    });
    if (!checkpointSignatureValid) {
      throw new RegistryCoreError('TRANSPARENCY_CHECKPOINT_SIGNATURE_INVALID', 'Checkpoint signature is invalid.');
    }
    const observedAt = input.observed_at ?? nowIso();
    const payloadProvenance = buildCheckpointPayloadProvenance({
      checkpoint_body: normalizedCheckpoint.checkpoint_body,
      checkpoint_signature: normalizedCheckpoint.checkpoint_signature,
      signed_note: normalizedCheckpoint.signed_note,
      note_format: normalizedCheckpoint.note_format,
    });
    const checkpointArtifact = await this.deps.cas.put({
      bytes: Buffer.from(
        canonicalJsonString({
          log_id: input.log_id,
          checkpoint_body: normalizedCheckpoint.checkpoint_body,
          checkpoint_signature: normalizedCheckpoint.checkpoint_signature,
          note_format: normalizedCheckpoint.note_format,
          parse_strategy: payloadProvenance.parse_strategy,
          payload_sha256: payloadProvenance.payload_sha256,
          signature_count: normalizedCheckpoint.signature_count,
          signatures: normalizedCheckpoint.signatures,
          ...(normalizedCheckpoint.signed_note ? { signed_note: normalizedCheckpoint.signed_note } : {}),
          ...(normalizedCheckpoint.signed_note_signer
            ? { signed_note_signer: normalizedCheckpoint.signed_note_signer }
            : {}),
          ...(normalizedCheckpoint.signed_note_key_hint
            ? { signed_note_key_hint: normalizedCheckpoint.signed_note_key_hint }
            : {}),
        }),
        'utf8',
      ),
      media_type: 'application/json',
      original_path: `generated/transparency-observed-checkpoint/${sanitizePathSegment(input.log_id)}-${checkpointFields.tree_size}.json`,
    });
    const checkpointArtifactUrn = artifactUrn(checkpointArtifact.sha256);
    await this.deps.graph.upsertNode({
      urn: checkpointArtifactUrn,
      entity_type: 'ARTIFACT',
      properties: {
        sha256: checkpointArtifact.sha256,
        size_bytes: checkpointArtifact.size_bytes,
        media_type: checkpointArtifact.media_type,
        original_path: checkpointArtifact.original_path,
        governance_role: 'transparency_observed_checkpoint',
        log_id: input.log_id,
        tree_size: checkpointFields.tree_size,
        root_hash: checkpointFields.root_hash,
        checkpoint_body: normalizedCheckpoint.checkpoint_body,
        checkpoint_signature: normalizedCheckpoint.checkpoint_signature,
        note_format: normalizedCheckpoint.note_format,
        signed_note_signature_count: normalizedCheckpoint.signature_count,
        signed_note_signatures_json: canonicalJsonString(normalizedCheckpoint.signatures),
        ...(normalizedCheckpoint.signed_note ? { signed_note: normalizedCheckpoint.signed_note } : {}),
        ...(normalizedCheckpoint.signed_note_signer
          ? { signed_note_signer: normalizedCheckpoint.signed_note_signer }
          : {}),
        ...(normalizedCheckpoint.signed_note_key_hint
          ? { signed_note_key_hint: normalizedCheckpoint.signed_note_key_hint }
          : {}),
        parse_strategy: payloadProvenance.parse_strategy,
        payload_sha256: payloadProvenance.payload_sha256,
        checkpoint_signature_valid: true,
        occurred_at: observedAt,
      },
    });
    const observationArtifact = await this.deps.cas.put({
      bytes: Buffer.from(
        canonicalJsonString({
          log_id: input.log_id,
          checkpoint_artifact_urn: checkpointArtifactUrn,
          observed_from_type: input.observed_from_type,
          observed_from_id: input.observed_from_id,
          observed_at: observedAt,
          note_format: payloadProvenance.note_format,
          parse_strategy: payloadProvenance.parse_strategy,
          payload_sha256: payloadProvenance.payload_sha256,
          ...(input.source_channel ? { source_channel: input.source_channel } : {}),
          ...(input.observer_id ? { observer_id: input.observer_id } : {}),
          ...(input.observer_type ? { observer_type: input.observer_type } : {}),
          ...(input.relay_from_type ? { relay_from_type: input.relay_from_type } : {}),
          ...(input.relay_from_id ? { relay_from_id: input.relay_from_id } : {}),
          ...(typeof input.relay_hop_count === 'number' ? { relay_hop_count: input.relay_hop_count } : {}),
          ...(input.source_checkpoint_occurred_at
            ? { source_checkpoint_occurred_at: input.source_checkpoint_occurred_at }
            : {}),
        }),
        'utf8',
      ),
      media_type: 'application/json',
      original_path: `generated/transparency-observation/${sanitizePathSegment(input.log_id)}-${sanitizePathSegment(input.observed_from_id)}.json`,
    });
    const observationArtifactUrn = artifactUrn(observationArtifact.sha256);
    await this.deps.graph.upsertNode({
      urn: observationArtifactUrn,
      entity_type: 'ARTIFACT',
      properties: {
        sha256: observationArtifact.sha256,
        size_bytes: observationArtifact.size_bytes,
        media_type: observationArtifact.media_type,
        original_path: observationArtifact.original_path,
        governance_role: 'transparency_checkpoint_observation',
        log_id: input.log_id,
        checkpoint_artifact_urn: checkpointArtifactUrn,
        observed_from_type: input.observed_from_type,
        observed_from_id: input.observed_from_id,
        observed_at: observedAt,
        note_format: payloadProvenance.note_format,
        parse_strategy: payloadProvenance.parse_strategy,
        payload_sha256: payloadProvenance.payload_sha256,
        ...(input.source_channel ? { source_channel: input.source_channel } : {}),
        ...(input.observer_id ? { observer_id: input.observer_id } : {}),
        ...(input.observer_type ? { observer_type: input.observer_type } : {}),
        ...(input.relay_from_type ? { relay_from_type: input.relay_from_type } : {}),
        ...(input.relay_from_id ? { relay_from_id: input.relay_from_id } : {}),
        ...(typeof input.relay_hop_count === 'number' ? { relay_hop_count: input.relay_hop_count } : {}),
        ...(input.source_checkpoint_occurred_at
          ? { source_checkpoint_occurred_at: input.source_checkpoint_occurred_at }
          : {}),
      },
    });
    await this.deps.graph.upsertEdge({
      from_urn: log.transparency_log.urn,
      to_urn: observationArtifactUrn,
      predicate: 'sg:observedCheckpoint',
      properties: {},
    });
    return {
      observation_artifact_urn: observationArtifactUrn,
      observed_from_type: input.observed_from_type,
      observed_from_id: input.observed_from_id,
      observed_at: observedAt,
      checkpoint_artifact_urn: checkpointArtifactUrn,
      tree_size: checkpointFields.tree_size,
      root_hash: checkpointFields.root_hash,
      note_format: payloadProvenance.note_format,
      parse_strategy: payloadProvenance.parse_strategy,
      payload_sha256: payloadProvenance.payload_sha256,
      ...(input.source_channel ? { source_channel: input.source_channel } : {}),
      ...(input.observer_id ? { observer_id: input.observer_id } : {}),
      ...(input.observer_type ? { observer_type: input.observer_type } : {}),
      ...(input.relay_from_type ? { relay_from_type: input.relay_from_type } : {}),
      ...(input.relay_from_id ? { relay_from_id: input.relay_from_id } : {}),
      ...(typeof input.relay_hop_count === 'number' ? { relay_hop_count: input.relay_hop_count } : {}),
      ...(input.source_checkpoint_occurred_at
        ? { source_checkpoint_occurred_at: input.source_checkpoint_occurred_at }
        : {}),
    };
  }

  async createTransparencyGossipEvent(
    input: import('../ports/registry-service.js').CreateTransparencyGossipEventInput,
  ): Promise<import('../ports/registry-service.js').RegistryTransparencyGossipEvent> {
    const log = await this.getTransparencyLog({ log_id: input.log_id });
    if (!log) throw new RegistryCoreError('TRANSPARENCY_LOG_NOT_FOUND', 'Transparency log not found.');
    const fromWitness = await this.deps.graph.getNode(transparencyWitnessUrn(input.from_witness_id));
    const toWitness = await this.deps.graph.getNode(transparencyWitnessUrn(input.to_witness_id));
    if (!fromWitness || fromWitness.entity_type !== 'TRANSPARENCY_WITNESS') {
      throw new RegistryCoreError('TRANSPARENCY_GOSSIP_INVALID_WITNESS', 'Source witness not found.');
    }
    if (!toWitness || toWitness.entity_type !== 'TRANSPARENCY_WITNESS') {
      throw new RegistryCoreError('TRANSPARENCY_GOSSIP_INVALID_WITNESS', 'Target witness not found.');
    }
    const checkpoint = await this.getTransparencyCheckpointDetails(input.checkpoint_artifact_urn);
    if (!checkpoint) {
      throw new RegistryCoreError('TRANSPARENCY_CHECKPOINT_INVALID', 'Referenced checkpoint not found.');
    }
    const payloadProvenance = buildCheckpointPayloadProvenance({
      checkpoint_body: checkpoint.checkpoint_body,
      checkpoint_signature: checkpoint.checkpoint_signature,
      signed_note: checkpoint.signed_note,
      note_format: checkpoint.note_format,
    });
    const occurredAt = input.occurred_at ?? nowIso();
    const eventId = randomUUID();
    const urn = transparencyGossipEventUrn(eventId);
    await this.deps.graph.upsertNode({
      urn,
      entity_type: 'TRANSPARENCY_GOSSIP_EVENT',
      properties: {
        event_id: eventId,
        log_id: input.log_id,
        from_witness_id: input.from_witness_id,
        to_witness_id: input.to_witness_id,
        checkpoint_artifact_urn: input.checkpoint_artifact_urn,
        occurred_at: occurredAt,
        event_type: 'checkpoint_gossip',
        note_format: payloadProvenance.note_format,
        parse_strategy: payloadProvenance.parse_strategy,
        payload_sha256: payloadProvenance.payload_sha256,
        ...(input.source_channel ? { source_channel: input.source_channel } : {}),
        ...(input.relayed_by_id ? { relayed_by_id: input.relayed_by_id } : {}),
        ...(typeof input.relay_hop_count === 'number' ? { relay_hop_count: input.relay_hop_count } : {}),
        ...((input.source_checkpoint_occurred_at ?? checkpoint.occurred_at)
          ? { source_checkpoint_occurred_at: input.source_checkpoint_occurred_at ?? checkpoint.occurred_at }
          : {}),
      },
    });
    await this.deps.graph.upsertEdge({
      from_urn: fromWitness.urn,
      to_urn: urn,
      predicate: 'sg:sentGossipEvent',
      properties: {},
    });
    await this.deps.graph.upsertEdge({
      from_urn: toWitness.urn,
      to_urn: urn,
      predicate: 'sg:receivedGossipEvent',
      properties: {},
    });
    await this.deps.graph.upsertEdge({
      from_urn: urn,
      to_urn: input.checkpoint_artifact_urn,
      predicate: 'sg:aboutCheckpoint',
      properties: {},
    });
    return {
      gossip_event_urn: urn,
      log_id: input.log_id,
      from_witness_id: input.from_witness_id,
      to_witness_id: input.to_witness_id,
      checkpoint_artifact_urn: input.checkpoint_artifact_urn,
      occurred_at: occurredAt,
      event_type: 'checkpoint_gossip',
      note_format: payloadProvenance.note_format,
      parse_strategy: payloadProvenance.parse_strategy,
      payload_sha256: payloadProvenance.payload_sha256,
      ...(input.source_channel ? { source_channel: input.source_channel } : {}),
      ...(input.relayed_by_id ? { relayed_by_id: input.relayed_by_id } : {}),
      ...(typeof input.relay_hop_count === 'number' ? { relay_hop_count: input.relay_hop_count } : {}),
      ...((input.source_checkpoint_occurred_at ?? checkpoint.occurred_at)
        ? { source_checkpoint_occurred_at: input.source_checkpoint_occurred_at ?? checkpoint.occurred_at }
        : {}),
    };
  }

  async getTransparencyLogVerification(input: { log_id: string }): Promise<import('../ports/registry-service.js').RegistryTransparencyLogVerification | null> {
    const log = await this.getTransparencyLog({ log_id: input.log_id });
    if (!log) return null;
    const checkpoint = log.current_checkpoint;
    const checkpointKeyRef = stringOrUndefined(log.transparency_log.properties['checkpoint_key_ref']);
    const checkpointKey = checkpointKeyRef ? await this.resolveTrustedPublicKeyMaterial(checkpointKeyRef) : null;
    if (!checkpoint) {
      return {
        transparency_log: log,
        checkpoint_signature_valid: false,
        checkpoint_consistency_verified: false,
        trusted_checkpoint_key_resolved: Boolean(checkpointKey),
        witness_quorum_required: numberOrUndefined(log.transparency_log.properties['witness_quorum']) ?? 0,
        witness_quorum_met: false,
        witness_checks: [],
        checkpoint_history: log.checkpoints,
        observations: [],
        disagreements: [],
        gossip_events: log.gossip_events,
        verification_status: 'missing_checkpoint',
      };
    }
    const checkpointBodyFields = parseCheckpointBody(checkpoint.checkpoint_body);
    const checkpointSignatureValid =
      checkpointKey &&
      verifyDetachedSignatureBytes({
        algorithm: checkpointKey.algorithm,
        public_key_pem: checkpointKey.public_key_pem,
        message: checkpoint.checkpoint_body,
        signature: checkpoint.checkpoint_signature,
      });
    const witnessChecks = await this.verifyWitnesses({
      log,
      checkpoint_artifact_urn: checkpoint.checkpoint_artifact_urn,
      checkpoint_body: checkpoint.checkpoint_body,
    });
    const observations = await this.listTransparencyCheckpointObservations(log.transparency_log.urn);
    const gossipEvents = log.gossip_events;
    const disagreements = dedupeTransparencyDisagreements(
      buildTransparencyDisagreements({
        log_id: input.log_id,
        observations,
        checkpoints: log.checkpoints,
      }),
    );
    const quorum = numberOrUndefined(log.transparency_log.properties['witness_quorum']) ?? 0;
    const validWitnesses = witnessChecks.filter((check) => check.verification_status === 'verified').length;
    const witnessQuorumMet = validWitnesses >= quorum;
    return {
      transparency_log: log,
      checkpoint_signature_valid: Boolean(checkpointSignatureValid),
      checkpoint_consistency_verified: Boolean(checkpoint.append_only_verified),
      trusted_checkpoint_key_resolved: Boolean(checkpointKey),
      witness_quorum_required: quorum,
      witness_quorum_met: witnessQuorumMet,
      witness_checks: witnessChecks,
      checkpoint_history: log.checkpoints,
      observations,
      disagreements,
      gossip_events: gossipEvents,
      verification_status: disagreements.length > 0
        ? 'consistency_failure'
        : !checkpointKey
        ? 'missing_checkpoint_key'
        : !checkpointBodyFields || !checkpointSignatureValid
          ? 'checkpoint_signature_invalid'
          : checkpoint.append_only_verified === false
            ? 'consistency_failure'
            : !witnessQuorumMet
              ? 'witness_quorum_unmet'
              : 'verified',
    };
  }

  async getTransparencyLogTimeline(input: { log_id: string }): Promise<{ events: import('../ports/registry-service.js').RegistryTransparencyTimelineEvent[] } | null> {
    const log = await this.getTransparencyLog({ log_id: input.log_id });
    if (!log) return null;
    const observations = await this.listTransparencyCheckpointObservations(log.transparency_log.urn);
    const disagreements = dedupeTransparencyDisagreements(
      buildTransparencyDisagreements({
        log_id: input.log_id,
        observations,
        checkpoints: log.checkpoints,
      }),
    );
    const witnessAttestations = await this.listWitnessAttestations(log.checkpoints.map((checkpoint) => checkpoint.checkpoint_artifact_urn));
    const events: import('../ports/registry-service.js').RegistryTransparencyTimelineEvent[] = [
      ...log.checkpoints.map((checkpoint) => ({
        event_id: checkpoint.checkpoint_artifact_urn,
        kind: 'checkpoint' as const,
        occurred_at: checkpoint.occurred_at ?? nowIso(),
        summary: `Checkpoint tree size ${checkpoint.tree_size} with root ${checkpoint.root_hash}.`,
        related_urns: [checkpoint.checkpoint_artifact_urn],
      })),
      ...observations.map((observation) => ({
        event_id: observation.observation_artifact_urn,
        kind: 'observation' as const,
        occurred_at: observation.observed_at,
        summary: `Observed checkpoint from ${observation.observed_from_type}:${observation.observed_from_id} at tree size ${observation.tree_size}.`,
        related_urns: [observation.observation_artifact_urn, observation.checkpoint_artifact_urn],
      })),
      ...witnessAttestations.map((attestation) => ({
        event_id: attestation.attestation_artifact_urn,
        kind: 'witness_attestation' as const,
        occurred_at: attestation.occurred_at,
        summary: `Witness ${attestation.witness_id} attested checkpoint ${attestation.checkpoint_artifact_urn}.`,
        related_urns: [attestation.attestation_artifact_urn, attestation.checkpoint_artifact_urn],
      })),
      ...log.gossip_events.map((event) => ({
        event_id: event.gossip_event_urn,
        kind: 'gossip' as const,
        occurred_at: event.occurred_at,
        summary: `Witness ${event.from_witness_id} gossiped checkpoint to ${event.to_witness_id}.`,
        related_urns: [event.gossip_event_urn, event.checkpoint_artifact_urn],
      })),
      ...disagreements.map((disagreement) => ({
        event_id: disagreement.disagreement_id,
        kind: 'disagreement' as const,
        occurred_at: disagreement.occurred_at ?? nowIso(),
        summary: disagreement.reason,
        related_urns: [disagreement.left_checkpoint_artifact_urn, disagreement.right_checkpoint_artifact_urn],
      })),
    ].sort((left, right) => left.occurred_at.localeCompare(right.occurred_at));
    return { events };
  }

  async listAgents(input: {
    harness_name?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ agents: import('../ports/registry-service.js').RegistryAgentSummary[] }> {
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
        ...(typeof n.properties['display_name'] === 'string'
          ? { display_name: n.properties['display_name'] as string }
          : {}),
        ...(typeof n.properties['description'] === 'string'
          ? { description: n.properties['description'] as string }
          : {}),
        ...(typeof n.properties['source_path'] === 'string'
          ? { source_path: n.properties['source_path'] as string }
          : {}),
      })),
    };
  }

  async getAgentByKey(input: { agent_key: string }): Promise<RegistryAgentDetails | null> {
    return await this.getAgentByUrn({ agent_urn: agentUrn(input.agent_key) });
  }

  async getAgentByUrn(input: { agent_urn: string }): Promise<RegistryAgentDetails | null> {
    const node = await this.deps.graph.getNode(input.agent_urn);
    if (!node) return null;

    const skillsEdges = await this.deps.graph.listEdgesFrom(node.urn, 'sg:usesSkill');
    const artifactEdges = await this.deps.graph.listEdgesFrom(node.urn, 'sg:definedBy');
    const harnessEdges = await this.deps.graph.listEdgesFrom(node.urn, 'sg:runsOn');
    const activeVersionUrn = stringOrUndefined(node.properties['active_version_urn']);
    const activeVersion = activeVersionUrn ? await this.getAgentVersionByUrn(activeVersionUrn) : null;

    return {
      agent: { urn: node.urn, properties: node.properties },
      ...(activeVersion ? { active_version: activeVersion } : {}),
      skills: dedupeSkillRefs([
        ...skillsEdges.map((e) => ({
          skill_urn: e.to_urn,
          ...(toOptionalStringProp('skill_key', parseSkillKey(e.to_urn))),
        })),
        ...(activeVersion?.skills ?? []),
      ]),
      artifacts: dedupeArtifacts([
        ...artifactEdges.map((e) => ({
          artifact_urn: e.to_urn,
          ...(toOptionalStringProp('sha256', parseArtifactSha256(e.to_urn))),
        })),
        ...(activeVersion?.artifacts ?? []),
      ]),
      harnesses: dedupeHarnessRefs([
        ...harnessEdges.map((e) => ({
          harness_urn: e.to_urn,
          ...(toOptionalStringProp('harness_name', parseHarnessName(e.to_urn))),
        })),
        ...(activeVersion?.harnesses ?? []),
      ]),
    };
  }

  async listAgentVersions(input: { agent_key: string }): Promise<{ versions: RegistryAgentVersionDetails[] }> {
    const agentNodeUrn = agentUrn(input.agent_key);
    const versionEdges = await this.deps.graph.listEdgesFrom(agentNodeUrn, 'sg:hasVersion');
    const versions: RegistryAgentVersionDetails[] = [];
    for (const edge of versionEdges) {
      const got = await this.getAgentVersionByUrn(edge.to_urn);
      if (got) versions.push(got);
    }
    versions.sort((a, b) => getVersionNumber(a.agent_version.properties) - getVersionNumber(b.agent_version.properties));
    return { versions };
  }

  async getActiveAgentVersion(input: { agent_key: string }): Promise<RegistryAgentVersionDetails | null> {
    const agent = await this.deps.graph.getNode(agentUrn(input.agent_key));
    const activeUrn = stringOrUndefined(agent?.properties['active_version_urn']);
    if (!activeUrn) return null;
    return await this.getAgentVersionByUrn(activeUrn);
  }

  async getAgentVersion(input: { agent_key: string; version: number }): Promise<RegistryAgentVersionDetails | null> {
    return await this.getAgentVersionByUrn(agentVersionUrn(input.agent_key, input.version));
  }

  async getAgentPublicationEnvelope(input: { agent_key: string; version: number }) {
    const version = await this.getAgentVersion(input);
    if (!version) return null;
    return await this.composeAgentPublicationEnvelope({ version, agent_key: input.agent_key });
  }

  async getAgentPublicationVerification(input: { agent_key: string; version: number }): Promise<RegistryPublicationVerification | null> {
    const version = await this.getAgentVersion(input);
    if (!version) return null;
    const envelope = await this.composeAgentPublicationEnvelope({ version, agent_key: input.agent_key });
    const liveEnvelope = await this.composeAgentPublicationEnvelope({
      version,
      agent_key: input.agent_key,
      prefer_frozen: false,
    });
    return await this.buildPublicationVerification(envelope, liveEnvelope);
  }

  async createAgentDetachedSignature(input: { agent_key: string; version: number } & RegistryDetachedSignatureInput) {
    const version = await this.getAgentVersion(input);
    if (!version) {
      throw new RegistryCoreError('AGENT_VERSION_NOT_FOUND', 'Agent version not found.');
    }
    if (!stringOrUndefined(version.agent_version.properties['published_at'])) {
      throw new RegistryCoreError('AGENT_SIGNATURE_CONFLICT', 'Only published agent versions can receive detached signatures.');
    }
    const envelope = await this.getAgentPublicationEnvelope(input);
    if (!envelope) {
      throw new RegistryCoreError('AGENT_SIGNATURE_CONFLICT', 'Agent publication envelope not available.');
    }
    const signedPayload = input.signed_payload ?? 'canonical_json';
    if (signedPayload === 'canonical_rdf' && !envelope.canonical_rdf_sha256) {
      throw new RegistryCoreError('AGENT_SIGNATURE_CONFLICT', 'Canonical RDF is not available for this publication.');
    }
    if (input.keyless_bundle !== undefined) {
      if (signedPayload === 'canonical_rdf') {
        throw new RegistryCoreError(
          'AGENT_VERSION_KEYLESS_SIGNATURE_INVALID',
          'canonical_rdf keyless signatures must be attached through the prepared publication flow (signed payload bytes are required for verification).',
        );
      }
      return await this.createKeylessDetachedSignature({
        publication_urn: version.agent_version.urn,
        logical_key: input.agent_key,
        signed_payload: signedPayload,
        envelope_sha256: envelope.canonical_json_sha256,
        keyless_bundle: input.keyless_bundle,
        signed_bytes: Buffer.from(envelope.canonical_json, 'utf8'),
        signer: input.signer,
        errorPrefix: 'AGENT_VERSION',
      });
    }
    if (!input.key_ref || !input.algorithm || !input.signature) {
      throw new RegistryCoreError(
        'AGENT_SIGNATURE_CONFLICT',
        'Detached signatures require key_ref, algorithm, and signature (or a keyless bundle).',
      );
    }
    await this.enforceTrustedPublisherOnSignature({
      properties: version.agent_version.properties,
      keyRef: input.key_ref,
      errorCode: 'AGENT_VERSION_SIGNATURE_PUBLISHER_MISMATCH',
    });
    return await this.createDetachedSignature({
      publication_urn: version.agent_version.urn,
      logical_key: input.agent_key,
      envelope_sha256:
        signedPayload === 'canonical_rdf'
          ? (envelope.canonical_rdf_sha256 as string)
          : envelope.canonical_json_sha256,
      signer: input.signer,
      key_ref: input.key_ref,
      algorithm: input.algorithm,
      signature: input.signature,
      ...(input.signed_payload ? { signed_payload: input.signed_payload } : {}),
      ...(input.transparency_log_ref ? { transparency_log_ref: input.transparency_log_ref } : {}),
      ...(input.inclusion_proof_ref ? { inclusion_proof_ref: input.inclusion_proof_ref } : {}),
      ...(input.inclusion_proof ? { inclusion_proof: input.inclusion_proof } : {}),
    });
  }

  async createAgent(input: CreateAgentInput): Promise<CreateResult<RegistryAgentDetails>> {
    const agentNodeUrn = agentUrn(input.agent_key);
    const existing = await this.deps.graph.getNode(agentNodeUrn);
    if (existing) {
      const existingView = await this.getAgentByKey({ agent_key: input.agent_key });
      if (!existingView) throw new RegistryCoreError('AGENT_CREATE_FAILED', 'Failed to read existing agent.');
      if (await this.matchesCreateAgentInput(existingView, input)) {
        return { value: existingView, created: false };
      }
      throw new RegistryCoreError('AGENT_CREATE_CONFLICT', 'Agent already exists with different state.');
    }

    const normalizedSkillRefs = await this.resolveAndValidateSkillRefs(input.skill_refs);
    const artifactRecord = input.artifact
      ? await this.deps.cas.put({
          bytes: decodeArtifactInput(input.artifact.content, input.artifact.encoding),
          ...(input.artifact.media_type ? { media_type: input.artifact.media_type } : {}),
          ...(input.artifact.original_path ? { original_path: input.artifact.original_path } : {}),
        })
      : undefined;

    await this.deps.graph.upsertNode({
      urn: agentNodeUrn,
      entity_type: 'AGENT',
      properties: {
        agent_key: input.agent_key,
        ...(input.harness_name ? { harness_name: input.harness_name } : {}),
        ...(input.display_name ? { display_name: input.display_name } : {}),
        ...(input.description ? { description: input.description } : {}),
        ...(resolveAgentSourcePath(input) ? { source_path: resolveAgentSourcePath(input) } : {}),
      },
    });

    if (input.harness_name) {
      const harnessNodeUrn = harnessUrn(input.harness_name);
      await this.deps.graph.upsertNode({
        urn: harnessNodeUrn,
        entity_type: 'HARNESS',
        properties: { harness_name: input.harness_name },
      });
      await this.deps.graph.upsertEdge({
        from_urn: agentNodeUrn,
        to_urn: harnessNodeUrn,
        predicate: 'sg:runsOn',
        properties: {},
      });
    }

    if (normalizedSkillRefs) {
      for (const ref of normalizedSkillRefs) {
        await this.deps.graph.upsertEdge({
          from_urn: agentNodeUrn,
          to_urn: ref.skill_urn,
          predicate: 'sg:usesSkill',
          properties: {},
        });
      }
    }

    if (artifactRecord) {
      const artifactNodeUrn = artifactUrn(artifactRecord.sha256);
      await this.deps.graph.upsertNode({
        urn: artifactNodeUrn,
        entity_type: 'ARTIFACT',
        properties: {
          sha256: artifactRecord.sha256,
          size_bytes: artifactRecord.size_bytes,
          ...(artifactRecord.media_type ? { media_type: artifactRecord.media_type } : {}),
          ...(artifactRecord.original_path ? { original_path: artifactRecord.original_path } : {}),
        },
      });
      await this.deps.graph.upsertEdge({
        from_urn: agentNodeUrn,
        to_urn: artifactNodeUrn,
        predicate: 'sg:definedBy',
        properties: {},
      });
    }

    const versionUrn = agentVersionUrn(input.agent_key, 1);
    const publication = buildPublicationGovernance({
      entity_type: 'AGENT_VERSION',
      urn: versionUrn,
      current_properties: {
        agent_key: input.agent_key,
        version: 1,
        publication_status: 'published',
        active: true,
        ...(input.harness_name ? { harness_name: input.harness_name } : {}),
        ...(input.display_name ? { display_name: input.display_name } : {}),
        ...(input.description ? { description: input.description } : {}),
        ...(resolveAgentSourcePath(input) ? { source_path: resolveAgentSourcePath(input) } : {}),
        ...(artifactRecord ? { artifact_sha256: artifactRecord.sha256 } : {}),
      },
      actor: input.governance?.publisher ?? 'registry-system',
      ...(input.governance ? { governance: input.governance } : {}),
      publishedAt: nowIso(),
    });
    const governanceArtifactDefs = buildDefaultGovernanceArtifacts({
      entity_type: 'AGENT_VERSION',
      logical_key: input.agent_key,
      publication_urn: versionUrn,
      actor: publication.properties['publisher'] as string,
      policy_version: publication.properties['policy_version'] as string,
      validation_report: publication.properties['validation_report'] as string,
    });
    const governanceArtifacts = [];
    for (const definition of governanceArtifactDefs) {
      governanceArtifacts.push(
        await this.createGovernanceArtifact({
          role: definition.role,
          logical_key: input.agent_key,
          publication_urn: versionUrn,
          payload: definition.payload,
        }),
      );
    }

    await this.deps.graph.upsertNode({
      urn: versionUrn,
      entity_type: 'AGENT_VERSION',
      properties: {
        agent_key: input.agent_key,
        version: 1,
        active: true,
        lifecycle_status: 'published',
        ...(input.harness_name ? { harness_name: input.harness_name } : {}),
        ...(input.display_name ? { display_name: input.display_name } : {}),
        ...(input.description ? { description: input.description } : {}),
        ...(resolveAgentSourcePath(input) ? { source_path: resolveAgentSourcePath(input) } : {}),
        ...(artifactRecord ? { artifact_sha256: artifactRecord.sha256 } : {}),
        ...publication.properties,
      },
    });
    await this.deps.graph.upsertEdge({
      from_urn: agentNodeUrn,
      to_urn: versionUrn,
      predicate: 'sg:hasVersion',
      properties: {},
    });

    if (input.harness_name) {
      await this.deps.graph.upsertEdge({
        from_urn: versionUrn,
        to_urn: harnessUrn(input.harness_name),
        predicate: 'sg:runsOn',
        properties: {},
      });
    }
    if (normalizedSkillRefs) {
      for (const ref of normalizedSkillRefs) {
        await this.deps.graph.upsertEdge({
          from_urn: versionUrn,
          to_urn: ref.skill_urn,
          predicate: 'sg:usesSkill',
          properties: {},
        });
      }
    }
    if (artifactRecord) {
      await this.deps.graph.upsertEdge({
        from_urn: versionUrn,
        to_urn: artifactUrn(artifactRecord.sha256),
        predicate: 'sg:definedBy',
        properties: {},
      });
    }
    await this.attachGovernanceArtifacts(versionUrn, governanceArtifacts);
    await this.recordPublicationAppendIntent({
      publication_urn: versionUrn,
      logical_key: input.agent_key,
      entity_type: 'AGENT_VERSION',
      note: 'initial agent publication',
    });
    await this.deps.graph.upsertNode({
      urn: agentNodeUrn,
      entity_type: 'AGENT',
      properties: {
        ...(await this.deps.graph.getNode(agentNodeUrn))?.properties,
        active_version_urn: versionUrn,
      },
    });

    const created = await this.getAgentByKey({ agent_key: input.agent_key });
    if (!created) throw new RegistryCoreError('AGENT_CREATE_FAILED', 'Failed to create agent.');
    return { value: created, created: true };
  }

  async listSkills(input: { limit?: number; offset?: number }): Promise<{ skills: import('../ports/registry-service.js').RegistrySkillSummary[] }> {
    const nodes = await this.deps.graph.listNodesByType('SKILL', {
      ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
      ...(typeof input.offset === 'number' ? { offset: input.offset } : {}),
    });
    return {
      skills: nodes.map((n) => ({
        skill_urn: n.urn,
        skill_key: String(n.properties['skill_key'] ?? n.urn),
        ...(typeof n.properties['display_name'] === 'string'
          ? { display_name: n.properties['display_name'] as string }
          : {}),
        ...(typeof n.properties['description'] === 'string'
          ? { description: n.properties['description'] as string }
          : {}),
        ...(typeof n.properties['source_path'] === 'string'
          ? { source_path: n.properties['source_path'] as string }
          : {}),
      })),
    };
  }

  async getSkillByKey(input: { skill_key: string }): Promise<RegistrySkillDetails | null> {
    return await this.getSkillByUrn({ skill_urn: skillUrn(input.skill_key) });
  }

  async getSkillByUrn(input: { skill_urn: string }): Promise<RegistrySkillDetails | null> {
    const node = await this.deps.graph.getNode(input.skill_urn);
    if (!node) return null;
    const directArtifactEdges = await this.deps.graph.listEdgesFrom(node.urn, 'sg:implementedBy');
    const activeVersionUrn = stringOrUndefined(node.properties['active_version_urn']);
    const activeVersion = activeVersionUrn ? await this.getSkillVersionByUrn(activeVersionUrn) : null;
    const artifacts = dedupeArtifacts([
      ...directArtifactEdges.map((e) => ({
        artifact_urn: e.to_urn,
        ...(toOptionalStringProp('sha256', parseArtifactSha256(e.to_urn))),
      })),
      ...(activeVersion?.artifacts ?? []),
    ]);

    return {
      skill: { urn: node.urn, properties: node.properties },
      ...(activeVersion ? { active_version: activeVersion } : {}),
      artifacts,
    };
  }

  async createSkill(input: CreateSkillInput): Promise<CreateResult<RegistrySkillDetails>> {
    const skillNodeUrn = skillUrn(input.skill_key);
    const existing = await this.deps.graph.getNode(skillNodeUrn);
    if (existing) {
      const existingView = await this.getSkillByKey({ skill_key: input.skill_key });
      if (!existingView) throw new RegistryCoreError('SKILL_CREATE_FAILED', 'Failed to read existing skill.');
      if (await this.matchesCreateSkillInput(existingView, input)) {
        return { value: existingView, created: false };
      }
      throw new RegistryCoreError('SKILL_CREATE_CONFLICT', 'Skill already exists with different state.');
    }

    const artifactRecord = input.artifact
      ? await this.deps.cas.put({
          bytes: decodeArtifactInput(input.artifact.content, input.artifact.encoding),
          ...(input.artifact.media_type ? { media_type: input.artifact.media_type } : {}),
          ...(input.artifact.original_path ? { original_path: input.artifact.original_path } : {}),
        })
      : undefined;

    await this.deps.graph.upsertNode({
      urn: skillNodeUrn,
      entity_type: 'SKILL',
      properties: {
        skill_key: input.skill_key,
        ...(input.display_name ? { display_name: input.display_name } : {}),
        ...(input.description ? { description: input.description } : {}),
        ...(resolveSkillSourcePath(input) ? { source_path: resolveSkillSourcePath(input) } : {}),
      },
    });

    if (artifactRecord) {
      const artifactNodeUrn = artifactUrn(artifactRecord.sha256);
      await this.deps.graph.upsertNode({
        urn: artifactNodeUrn,
        entity_type: 'ARTIFACT',
        properties: {
          sha256: artifactRecord.sha256,
          size_bytes: artifactRecord.size_bytes,
          ...(artifactRecord.media_type ? { media_type: artifactRecord.media_type } : {}),
          ...(artifactRecord.original_path ? { original_path: artifactRecord.original_path } : {}),
        },
      });
      await this.deps.graph.upsertEdge({
        from_urn: skillNodeUrn,
        to_urn: artifactNodeUrn,
        predicate: 'sg:implementedBy',
        properties: {},
      });
    }

    const created = await this.getSkillByKey({ skill_key: input.skill_key });
    if (!created) throw new RegistryCoreError('SKILL_CREATE_FAILED', 'Failed to create skill.');
    return { value: created, created: true };
  }

  async listSkillVersions(input: { skill_key: string }): Promise<{ versions: RegistrySkillVersionDetails[] }> {
    const skillNodeUrn = skillUrn(input.skill_key);
    const versionEdges = await this.deps.graph.listEdgesFrom(skillNodeUrn, 'sg:hasVersion');
    const versions: RegistrySkillVersionDetails[] = [];
    for (const edge of versionEdges) {
      const got = await this.getSkillVersionByUrn(edge.to_urn);
      if (got) versions.push(got);
    }
    versions.sort((a, b) => getVersionNumber(a.skill_version.properties) - getVersionNumber(b.skill_version.properties));
    return { versions };
  }

  async getSkillVersion(input: { skill_key: string; version: number }): Promise<RegistrySkillVersionDetails | null> {
    return await this.getSkillVersionByUrn(skillVersionUrn(input.skill_key, input.version));
  }

  async getActiveSkillVersion(input: { skill_key: string }): Promise<RegistrySkillVersionDetails | null> {
    const skill = await this.deps.graph.getNode(skillUrn(input.skill_key));
    const activeUrn = stringOrUndefined(skill?.properties['active_version_urn']);
    if (!activeUrn) return null;
    return await this.getSkillVersionByUrn(activeUrn);
  }

  async getSkillPublicationEnvelope(input: { skill_key: string; version: number }) {
    const version = await this.getSkillVersion(input);
    if (!version) return null;
    return await this.composeSkillPublicationEnvelope({ version, skill_key: input.skill_key });
  }

  async getSkillPublicationVerification(input: { skill_key: string; version: number }): Promise<RegistryPublicationVerification | null> {
    const version = await this.getSkillVersion(input);
    if (!version) return null;
    const envelope = await this.composeSkillPublicationEnvelope({ version, skill_key: input.skill_key });
    const liveEnvelope = await this.composeSkillPublicationEnvelope({
      version,
      skill_key: input.skill_key,
      prefer_frozen: false,
    });
    return await this.buildPublicationVerification(envelope, liveEnvelope);
  }

  // Composes the served publication envelope. When a frozen envelope artifact
  // was recorded at publish time its bytes are served as the canonical
  // payload, so signatures and digests stay stable while later evidence is
  // attached. `prefer_frozen: false` derives the current live payload so
  // verification can report drift.
  private async composeSkillPublicationEnvelope(input: {
    version: import('../ports/registry-service.js').RegistrySkillVersionDetails;
    skill_key: string;
    prefer_frozen?: boolean;
  }) {
    const detached_signatures = await this.getDetachedSignatures(input.version.skill_version.urn);
    const transparencyAppendIntent = readTransparencyAppendIntentFromProperties(input.version.skill_version.properties);
    const frozen =
      input.prefer_frozen === false
        ? null
        : await this.readFrozenPublicationEnvelope(input.version.skill_version.properties);
    return buildPublicationEnvelope({
      publication_urn: input.version.skill_version.urn,
      logical_urn: skillUrn(input.skill_key),
      entity_type: 'SKILL_VERSION',
      properties: input.version.skill_version.properties,
      artifacts: input.version.artifacts,
      governance_artifacts: input.version.governance_artifacts,
      detached_signatures,
      ...(transparencyAppendIntent ? { transparency_append_intent: transparencyAppendIntent } : {}),
      ...(frozen ? { frozen_canonical_json: frozen.content, frozen_canonical_json_sha256: frozen.sha256 } : {}),
    });
  }

  private async composeAgentPublicationEnvelope(input: {
    version: import('../ports/registry-service.js').RegistryAgentVersionDetails;
    agent_key: string;
    prefer_frozen?: boolean;
  }) {
    const detached_signatures = await this.getDetachedSignatures(input.version.agent_version.urn);
    const transparencyAppendIntent = readTransparencyAppendIntentFromProperties(input.version.agent_version.properties);
    const frozen =
      input.prefer_frozen === false
        ? null
        : await this.readFrozenPublicationEnvelope(input.version.agent_version.properties);
    return buildPublicationEnvelope({
      publication_urn: input.version.agent_version.urn,
      logical_urn: agentUrn(input.agent_key),
      entity_type: 'AGENT_VERSION',
      properties: input.version.agent_version.properties,
      artifacts: input.version.artifacts,
      governance_artifacts: input.version.governance_artifacts,
      detached_signatures,
      ...(transparencyAppendIntent ? { transparency_append_intent: transparencyAppendIntent } : {}),
      ...(frozen ? { frozen_canonical_json: frozen.content, frozen_canonical_json_sha256: frozen.sha256 } : {}),
    });
  }

  private async readFrozenPublicationEnvelope(
    properties: Record<string, unknown>,
  ): Promise<{ artifact_urn: string; sha256: string; content: string } | null> {
    const artifactUrnValue = stringOrUndefined(properties['publication_envelope_artifact_urn']);
    if (!artifactUrnValue) return null;
    const sha256 = stringOrUndefined(properties['publication_envelope_sha256']) ?? parseArtifactSha256(artifactUrnValue);
    if (!sha256) return null;
    const got = await this.deps.cas.getBySha256(sha256);
    if (!got) return null;
    // Never serve bytes that failed their own integrity check: fall back to
    // the derived payload and let verification report the artifact mismatch.
    if (!got.digest_verified) return null;
    return {
      artifact_urn: artifactUrnValue,
      sha256,
      content: new TextDecoder('utf-8', { fatal: false }).decode(got.bytes),
    };
  }

  // Freezes the publication envelope bytes at publish time and records the
  // artifact on the version. The frozen payload excludes the artifact
  // reference itself, so it stays byte stable across later derivations.
  private async freezePublicationEnvelope(input: {
    publication_urn: string;
    entity_type: 'AGENT_VERSION' | 'SKILL_VERSION';
    logical_key: string;
  }): Promise<{ artifact_urn: string; sha256: string } | null> {
    const version = extractVersionFromPublicationUrn(input.publication_urn);
    const envelope =
      input.entity_type === 'AGENT_VERSION'
        ? await this.getAgentPublicationEnvelope({ agent_key: input.logical_key, version })
        : await this.getSkillPublicationEnvelope({ skill_key: input.logical_key, version });
    if (!envelope) return null;
    const artifact = await this.deps.cas.put({
      bytes: Buffer.from(envelope.canonical_json, 'utf8'),
      media_type: 'application/json',
      original_path: `generated/publication-envelope/${sanitizePathSegment(input.logical_key)}.json`,
    });
    const artifactNodeUrn = artifactUrn(artifact.sha256);
    await this.deps.graph.upsertNode({
      urn: artifactNodeUrn,
      entity_type: 'ARTIFACT',
      properties: {
        sha256: artifact.sha256,
        size_bytes: artifact.size_bytes,
        media_type: artifact.media_type,
        original_path: artifact.original_path,
        governance_role: 'publication_envelope',
      },
    });
    await this.deps.graph.upsertEdge({
      from_urn: input.publication_urn,
      to_urn: artifactNodeUrn,
      predicate: 'sg:hasPublicationEnvelope',
      properties: {},
    });
    const fresh = await this.deps.graph.getNode(input.publication_urn);
    if (fresh) {
      await this.deps.graph.upsertNode({
        urn: fresh.urn,
        entity_type: fresh.entity_type,
        properties: {
          ...fresh.properties,
          publication_envelope_artifact_urn: artifactNodeUrn,
          publication_envelope_sha256: artifact.sha256,
        },
      });
    }
    return { artifact_urn: artifactNodeUrn, sha256: artifact.sha256 };
  }

  // -------------------------------------------------------------------------
  // Single-request sign-then-publish (prepared publications)
  // -------------------------------------------------------------------------

  async prepareSkillPublication(
    input: import('../ports/registry-service.js').SkillVersionOperationInput,
  ): Promise<import('../ports/registry-service.js').RegistryPreparedPublication> {
    const version = await this.getSkillVersion(input);
    if (!version) {
      throw new RegistryCoreError('SKILL_VERSION_NOT_FOUND', 'Skill version not found.');
    }
    const currentStatus = lifecycleStatus(version.skill_version.properties);
    if (currentStatus !== 'draft' && currentStatus !== 'validated') {
      throw new RegistryCoreError(
        'SKILL_VERSION_PREPARE_CONFLICT',
        `Skill version cannot prepare a publication from status ${currentStatus}.`,
      );
    }
    await this.enforceHumanReviewGate({
      properties: version.skill_version.properties,
      errorCode: 'SKILL_VERSION_PUBLISH_CONFLICT',
      action: 'publish',
    });
    await this.enforcePublicationTrustGates({
      publication_urn: version.skill_version.urn,
      properties: version.skill_version.properties,
      operation: 'publish',
      errorCodePrefix: 'SKILL_VERSION',
    });
    return await this.preparePublicationRecord({
      entity_type: 'SKILL_VERSION',
      logical_key: input.skill_key,
      logical_urn: skillUrn(input.skill_key),
      publication_urn: version.skill_version.urn,
      version_properties: version.skill_version.properties,
      artifacts: version.artifacts,
      author: input.author,
      ...(input.note ? { note: input.note } : {}),
      ...(input.governance ? { governance: input.governance } : {}),
      activate_if_missing: true,
      append_intent_note: 'skill publication',
    });
  }

  async prepareAgentPublication(
    input: import('../ports/registry-service.js').AgentVersionOperationInput,
  ): Promise<import('../ports/registry-service.js').RegistryPreparedPublication> {
    const version = await this.getAgentVersion(input);
    if (!version) {
      throw new RegistryCoreError('AGENT_VERSION_NOT_FOUND', 'Agent version not found.');
    }
    const currentStatus = lifecycleStatus(version.agent_version.properties);
    if (currentStatus !== 'draft' && currentStatus !== 'validated') {
      throw new RegistryCoreError(
        'AGENT_VERSION_PREPARE_CONFLICT',
        `Agent version cannot prepare a publication from status ${currentStatus}.`,
      );
    }
    await this.enforceHumanReviewGate({
      properties: version.agent_version.properties,
      errorCode: 'AGENT_VERSION_PUBLISH_CONFLICT',
      action: 'publish',
    });
    await this.enforcePublicationTrustGates({
      publication_urn: version.agent_version.urn,
      properties: version.agent_version.properties,
      operation: 'publish',
      errorCodePrefix: 'AGENT_VERSION',
    });
    return await this.preparePublicationRecord({
      entity_type: 'AGENT_VERSION',
      logical_key: input.agent_key,
      logical_urn: agentUrn(input.agent_key),
      publication_urn: version.agent_version.urn,
      version_properties: version.agent_version.properties,
      artifacts: version.artifacts,
      author: input.author,
      ...(input.note ? { note: input.note } : {}),
      ...(input.governance ? { governance: input.governance } : {}),
      activate_if_missing: true,
      append_intent_note: 'initial agent publication',
    });
  }

  private async preparePublicationRecord(input: {
    entity_type: 'SKILL_VERSION' | 'AGENT_VERSION';
    logical_key: string;
    logical_urn: string;
    publication_urn: string;
    version_properties: Record<string, unknown>;
    artifacts: Array<{ artifact_urn: string; sha256?: string }>;
    author: string;
    note?: string;
    governance?: import('../ports/registry-service.js').RegistryGovernanceInput;
    activate_if_missing: boolean;
    append_intent_note: string;
  }): Promise<import('../ports/registry-service.js').RegistryPreparedPublication> {
    const pinned = { published_at: nowIso(), updated_at: nowIso() };
    let append_intent: import('../ports/registry-service.js').RegistryTransparencyAppendIntentRef | null = null;
    let artifact_append_intents: PreparedPublicationRecord['pinned']['artifact_append_intents'] = [];
    if (this.deps.appendIntentPublisher) {
      // Reserve the per-artifact transparency intents first: their props are
      // embedded in the envelope's governance_artifacts entries, so they must
      // be pinned before the candidate bytes are derived.
      const reservationPlan = await this.computePublicationCandidate({
        ...input,
        pinned,
        append_intent: null,
        artifact_append_intents: [],
        include_rdf: false,
      });
      for (const payloadEntry of reservationPlan.governance_artifact_payloads) {
        const intent = await this.reserveGovernanceArtifactAppendIntent({
          artifact_urn: payloadEntry.artifact_urn,
          role: payloadEntry.role,
          logical_key: input.logical_key,
          publication_urn: input.publication_urn,
          sha256: parseArtifactSha256(payloadEntry.artifact_urn) ?? '',
          payload: payloadEntry.payload,
        });
        if (intent) {
          artifact_append_intents.push({
            role: payloadEntry.role,
            artifact_urn: payloadEntry.artifact_urn,
            intent,
          });
        }
      }
      // The version-level append intent digests the pre-append, pre-RDF
      // envelope (the same point in the legacy publish order); its props then
      // enter the RDF projection and the frozen bytes.
      const preAppend = await this.computePublicationCandidate({
        ...input,
        pinned,
        append_intent: null,
        artifact_append_intents,
        include_rdf: false,
      });
      append_intent = await this.reservePublicationAppendIntent({
        publication_urn: input.publication_urn,
        logical_urn: input.logical_urn,
        entity_type: input.entity_type,
        logical_key: input.logical_key,
        digest: preAppend.canonical_json_sha256,
        governance_artifact_urns: preAppend.governance_artifacts.map((artifact) => artifact.artifact_urn),
        note: input.append_intent_note,
      });
    }
    const candidate = await this.computePublicationCandidate({
      ...input,
      pinned,
      append_intent,
      artifact_append_intents,
      include_rdf: true,
    });
    const created_at = nowIso();
    const expires_at = new Date(Date.now() + PREPARED_PUBLICATION_TTL_MS).toISOString();
    const record: PreparedPublicationRecord = {
      schema: PREPARED_PUBLICATION_SCHEMA,
      publication_urn: input.publication_urn,
      logical_urn: input.logical_urn,
      entity_type: input.entity_type,
      logical_key: input.logical_key,
      created_at,
      expires_at,
      inputs: {
        author: input.author,
        note: input.note ?? null,
        governance: input.governance ?? null,
      },
      pinned: {
        published_at: pinned.published_at,
        updated_at: pinned.updated_at,
        append_intent,
        artifact_append_intents,
      },
      candidate,
    };
    const artifact = await this.deps.cas.put({
      bytes: Buffer.from(canonicalJsonString(record), 'utf8'),
      media_type: 'application/json',
      original_path: `generated/prepared-publication/${sanitizePathSegment(input.logical_key)}.json`,
    });
    const preparedPublicationUrn = artifactUrn(artifact.sha256);
    await this.deps.graph.upsertNode({
      urn: preparedPublicationUrn,
      entity_type: 'ARTIFACT',
      properties: {
        sha256: artifact.sha256,
        size_bytes: artifact.size_bytes,
        media_type: artifact.media_type,
        original_path: artifact.original_path,
        governance_role: 'prepared_publication',
        publication_urn: input.publication_urn,
        expires_at,
      },
    });
    return {
      prepared_publication_urn: preparedPublicationUrn,
      publication_urn: input.publication_urn,
      expires_at,
      canonical_json: candidate.canonical_json,
      canonical_json_sha256: candidate.canonical_json_sha256,
      canonicalization_algorithm: JCS_CANONICALIZATION_ALGORITHM,
      ...(candidate.canonical_rdf_sha256 ? { canonical_rdf_sha256: candidate.canonical_rdf_sha256 } : {}),
      ...(candidate.canonical_rdf_sha256
        ? { canonical_rdf_artifact_urn: artifactUrn(candidate.canonical_rdf_sha256) }
        : {}),
    };
  }

  private async computePublicationCandidate(input: {
    entity_type: 'SKILL_VERSION' | 'AGENT_VERSION';
    logical_key: string;
    logical_urn: string;
    publication_urn: string;
    version_properties: Record<string, unknown>;
    artifacts: Array<{ artifact_urn: string; sha256?: string }>;
    author: string;
    note?: string;
    governance?: import('../ports/registry-service.js').RegistryGovernanceInput;
    activate_if_missing: boolean;
    pinned: { published_at: string; updated_at: string };
    append_intent: import('../ports/registry-service.js').RegistryTransparencyAppendIntentRef | null;
    artifact_append_intents: PreparedPublicationRecord['pinned']['artifact_append_intents'];
    include_rdf: boolean;
  }): Promise<PreparedPublicationRecord['candidate']> {
    const publication = buildPublicationGovernance({
      entity_type: input.entity_type,
      urn: input.publication_urn,
      current_properties: input.version_properties,
      actor: input.author,
      ...(input.governance ? { governance: input.governance } : {}),
      publishedAt: input.pinned.published_at,
      ...(input.note ? { note: input.note } : {}),
    });

    const active =
      input.activate_if_missing &&
      (input.entity_type === 'SKILL_VERSION'
        ? !(await this.getActiveSkillVersion({ skill_key: input.logical_key }))
        : !(await this.getActiveAgentVersion({ agent_key: input.logical_key })));

    const baseProperties: Record<string, unknown> = {
      ...input.version_properties,
      ...publication.properties,
      lifecycle_status: 'published',
      updated_at: input.pinned.updated_at,
      ...(active ? { active: true } : {}),
    };

    const plan = await this.resolvePublicationGovernanceArtifactPlan({
      entity_type: input.entity_type,
      logical_key: input.logical_key,
      publication_urn: input.publication_urn,
      publisher: publication.properties['publisher'] as string,
      policy_version: publication.properties['policy_version'] as string,
      validation_report: publication.properties['validation_report'] as string,
      artifact_append_intents: input.artifact_append_intents,
    });
    const governanceArtifacts = plan.refs;
    const governanceArtifactPayloads = plan.new_artifact_payloads;

    const propertiesWithAppend = input.append_intent
      ? { ...baseProperties, ...transparencyAppendIntentProps(input.append_intent) }
      : baseProperties;

    let finalProperties = propertiesWithAppend;
    let canonical_rdf_nquads: string | null = null;
    let canonical_rdf_sha256: string | null = null;
    if (input.include_rdf) {
      const seenEdges = new Set<string>();
      const edges: Array<{ predicate: string; to_urn: string }> = [];
      for (const edge of await this.deps.graph.listEdgesFrom(input.publication_urn)) {
        if (PREPARED_PUBLICATION_EXCLUDED_EDGE_PREDICATES.has(edge.predicate)) continue;
        const key = `${edge.predicate}|${edge.to_urn}`;
        if (seenEdges.has(key)) continue;
        seenEdges.add(key);
        edges.push({ predicate: edge.predicate, to_urn: edge.to_urn });
      }
      for (const artifact of governanceArtifacts) {
        const predicate = artifact.role === 'policy_package' ? 'sg:governedByPolicy' : 'sg:validatedBy';
        const key = `${predicate}|${artifact.artifact_urn}`;
        if (seenEdges.has(key)) continue;
        seenEdges.add(key);
        edges.push({ predicate, to_urn: artifact.artifact_urn });
      }
      let lines: string[];
      try {
        lines = projectPublicationGraphToNQuads({
          publication_urn: input.publication_urn,
          logical_urn: input.logical_urn,
          properties: omitProperties(propertiesWithAppend, PUBLICATION_PROJECTION_PROP_KEYS),
          edges,
        });
      } catch (err) {
        throw new RegistryCoreError(
          'CANONICAL_RDF_INVALID_IRI',
          err instanceof Error ? err.message : 'Publication graph contains an invalid IRI.',
        );
      }
      const rdf = await computeCanonicalRdf(lines);
      canonical_rdf_nquads = rdf.nquads;
      canonical_rdf_sha256 = rdf.sha256;
      finalProperties = {
        ...propertiesWithAppend,
        canonical_rdf_sha256: rdf.sha256,
        canonical_rdf_artifact_urn: artifactUrn(rdf.sha256),
      };
    }

    const canonical_json = canonicalizeWith(JCS_CANONICALIZATION_ALGORITHM, {
      publication_urn: input.publication_urn,
      logical_urn: input.logical_urn,
      entity_type: input.entity_type,
      properties: omitPublicationEnvelopeProps(finalProperties),
      artifacts: input.artifacts,
      governance_artifacts: governanceArtifacts,
    });
    return {
      properties: finalProperties,
      governance_artifacts: governanceArtifacts,
      governance_artifact_payloads: governanceArtifactPayloads,
      canonical_json,
      canonical_json_sha256: sha256Hex(Buffer.from(canonical_json, 'utf8')),
      canonical_rdf_nquads,
      canonical_rdf_sha256,
    };
  }

  private async reservePublicationAppendIntent(input: {
    publication_urn: string;
    logical_urn: string;
    entity_type: 'SKILL_VERSION' | 'AGENT_VERSION';
    logical_key: string;
    digest: string;
    governance_artifact_urns: string[];
    note: string;
  }): Promise<import('../ports/registry-service.js').RegistryTransparencyAppendIntentRef | null> {
    if (!this.deps.appendIntentPublisher) return null;
    const appendIntent = await this.deps.appendIntentPublisher.publishAppendIntent({
      source_urn: input.publication_urn,
      source_type: 'publication_envelope',
      digest: input.digest,
      digest_algorithm: 'sha256',
      content_type: 'application/json',
      note: input.note,
      payload: {
        publication_urn: input.publication_urn,
        logical_urn: input.logical_urn,
        entity_type: input.entity_type,
        canonical_json_sha256: input.digest,
        governance_artifact_urns: input.governance_artifact_urns,
      },
    });
    return await this.attachCheckpointArtifactToAppendIntent(appendIntent, input.logical_key);
  }

  // Reserve a governance-artifact transparency intent without stamping it on
  // the (not yet existing) artifact node; publish stamps the pinned ref later.
  private async reserveGovernanceArtifactAppendIntent(input: {
    artifact_urn: string;
    role: 'policy_package' | 'validation_report';
    logical_key: string;
    publication_urn: string;
    sha256: string;
    payload: Record<string, unknown>;
  }): Promise<import('../ports/registry-service.js').RegistryTransparencyAppendIntentRef | null> {
    if (!this.deps.appendIntentPublisher) return null;
    const appendIntent = await this.deps.appendIntentPublisher.publishAppendIntent({
      source_urn: input.artifact_urn,
      source_type: 'governance_event',
      digest: input.sha256,
      digest_algorithm: 'sha256',
      content_type: 'application/json',
      note: input.role,
      payload: {
        role: input.role,
        logical_key: input.logical_key,
        publication_urn: input.publication_urn,
        artifact_urn: input.artifact_urn,
        payload: input.payload,
      },
    });
    return await this.attachCheckpointArtifactToAppendIntent(
      appendIntent,
      `${input.logical_key}-${input.role}`,
    );
  }

  // Resolve the governance-artifact refs a publication will present once a
  // publish attaches its own artifacts: the refs already on the node (draft
  // and validation evidence) merged with the refs publish will add (registered
  // policy package preferred over the placeholder), mirroring publish-time
  // order. Placeholder entries carry the deterministic payload plus any
  // pinned reservation.
  private async resolvePublicationGovernanceArtifactPlan(input: {
    entity_type: 'SKILL_VERSION' | 'AGENT_VERSION';
    logical_key: string;
    publication_urn: string;
    publisher: string;
    policy_version: string;
    validation_report: string;
    artifact_append_intents: PreparedPublicationRecord['pinned']['artifact_append_intents'];
  }): Promise<{
    refs: import('../ports/registry-service.js').RegistryGovernanceArtifactRef[];
    new_artifact_payloads: Array<{
      role: 'policy_package' | 'validation_report';
      artifact_urn: string;
      payload: Record<string, unknown>;
    }>;
  }> {
    const existing = await this.loadGovernanceArtifacts(input.publication_urn);
    const definitions = buildDefaultGovernanceArtifacts({
      entity_type: input.entity_type,
      logical_key: input.logical_key,
      publication_urn: input.publication_urn,
      actor: input.publisher,
      policy_version: input.policy_version,
      validation_report: input.validation_report,
    });
    const registeredPolicy = await this.findPolicyPackageNode(input.policy_version);
    const additions: import('../ports/registry-service.js').RegistryGovernanceArtifactRef[] = [];
    const newArtifactPayloads: Array<{
      role: 'policy_package' | 'validation_report';
      artifact_urn: string;
      payload: Record<string, unknown>;
    }> = [];
    for (const definition of definitions) {
      if (definition.role === 'policy_package' && registeredPolicy) {
        const sha = stringOrUndefined(registeredPolicy.properties['sha256']) ?? parseArtifactSha256(registeredPolicy.urn);
        const registeredIntent = readTransparencyAppendIntentFromProperties(registeredPolicy.properties);
        additions.push({
          role: 'policy_package',
          artifact_urn: registeredPolicy.urn,
          ...(sha ? { sha256: sha } : {}),
          ...(registeredIntent ? { transparency_append_intent: registeredIntent } : {}),
        });
        continue;
      }
      const ref = pureGovernanceArtifactRef({
        role: definition.role,
        logical_key: input.logical_key,
        publication_urn: input.publication_urn,
        payload: definition.payload,
      });
      const pinnedIntent = input.artifact_append_intents.find(
        (entry) => entry.artifact_urn === ref.artifact_urn,
      );
      const intent = pinnedIntent
        ? readTransparencyAppendIntentFromProperties(transparencyAppendIntentProps(pinnedIntent.intent))
        : undefined;
      additions.push({
        role: definition.role,
        artifact_urn: ref.artifact_urn,
        ...(ref.sha256 ? { sha256: ref.sha256 } : {}),
        ...(intent ? { transparency_append_intent: intent } : {}),
      });
      newArtifactPayloads.push({
        role: definition.role,
        artifact_urn: ref.artifact_urn,
        payload: definition.payload,
      });
    }
    return {
      refs: mergeGovernanceArtifactRefs(existing, additions),
      new_artifact_payloads: newArtifactPayloads,
    };
  }

  private async loadPreparedPublicationRecord(input: {
    prepared_publication_urn: string;
    expected_publication_urn: string;
    errorPrefix: 'SKILL_VERSION' | 'AGENT_VERSION';
  }): Promise<PreparedPublicationRecord> {
    const notFound = () =>
      new RegistryCoreError(
        `${input.errorPrefix}_PUBLISH_PREPARED_NOT_FOUND`,
        'Prepared publication not found.',
      );
    const sha256 = parseArtifactSha256(input.prepared_publication_urn);
    const stored = sha256 ? await this.deps.cas.getBySha256(sha256) : null;
    if (!stored || !stored.digest_verified) throw notFound();
    let record: PreparedPublicationRecord;
    try {
      record = JSON.parse(new TextDecoder('utf-8', { fatal: false }).decode(stored.bytes)) as PreparedPublicationRecord;
    } catch {
      throw notFound();
    }
    if (record.schema !== PREPARED_PUBLICATION_SCHEMA || record.publication_urn !== input.expected_publication_urn) {
      throw notFound();
    }
    if (Date.parse(record.expires_at) <= Date.now()) {
      throw new RegistryCoreError(
        `${input.errorPrefix}_PUBLISH_PREPARED_EXPIRED`,
        'Prepared publication expired; run prepare again.',
      );
    }
    return record;
  }

  private async verifyPreparedPublicationRecord(input: {
    record: PreparedPublicationRecord;
    entity_type: 'SKILL_VERSION' | 'AGENT_VERSION';
    logical_key: string;
    logical_urn: string;
    publication_urn: string;
    version_properties: Record<string, unknown>;
    artifacts: Array<{ artifact_urn: string; sha256?: string }>;
    author: string;
    note?: string;
    governance?: import('../ports/registry-service.js').RegistryGovernanceInput;
    activate_if_missing: boolean;
    errorPrefix: 'SKILL_VERSION' | 'AGENT_VERSION';
  }): Promise<void> {
    const stale = () =>
      new RegistryCoreError(
        `${input.errorPrefix}_PUBLISH_PREPARED_STALE`,
        'The prepared publication no longer matches the current state; run prepare again and re-sign.',
      );
    const requestFingerprint = preparedPublicationInputsFingerprint({
      author: input.author,
      ...(input.note ? { note: input.note } : {}),
      ...(input.governance ? { governance: input.governance } : {}),
    });
    const recordFingerprint = canonicalJsonString({
      author: input.record.inputs.author,
      note: input.record.inputs.note,
      governance: input.record.inputs.governance,
    });
    if (requestFingerprint !== recordFingerprint) throw stale();
    const recomputed = await this.computePublicationCandidate({
      entity_type: input.entity_type,
      logical_key: input.logical_key,
      logical_urn: input.logical_urn,
      publication_urn: input.publication_urn,
      version_properties: input.version_properties,
      artifacts: input.artifacts,
      author: input.author,
      ...(input.note ? { note: input.note } : {}),
      ...(input.governance ? { governance: input.governance } : {}),
      activate_if_missing: input.activate_if_missing,
      pinned: {
        published_at: input.record.pinned.published_at,
        updated_at: input.record.pinned.updated_at,
      },
      append_intent: input.record.pinned.append_intent,
      artifact_append_intents: input.record.pinned.artifact_append_intents,
      include_rdf: true,
    });
    if (recomputed.canonical_json_sha256 !== input.record.candidate.canonical_json_sha256) throw stale();
  }

  private async attachPublicationSignatures(input: {
    publication_urn: string;
    logical_key: string;
    candidate: PreparedPublicationRecord['candidate'];
    candidate_properties: Record<string, unknown>;
    signatures: import('../ports/registry-service.js').RegistryDetachedSignatureInput[];
    errorPrefix: 'SKILL_VERSION' | 'AGENT_VERSION';
  }): Promise<string[]> {
    const artifactUrns: string[] = [];
    for (const signature of input.signatures) {
      const signedPayload = signature.signed_payload ?? 'canonical_json';
      const digest =
        signedPayload === 'canonical_rdf'
          ? input.candidate.canonical_rdf_sha256
          : input.candidate.canonical_json_sha256;
      const message =
        signedPayload === 'canonical_rdf'
          ? input.candidate.canonical_rdf_nquads
          : input.candidate.canonical_json;
      if (!digest || !message) {
        throw new RegistryCoreError(
          `${input.errorPrefix}_SIGNATURE_INVALID`,
          'The prepared publication does not provide the signed payload.',
        );
      }
      if (signature.keyless_bundle !== undefined) {
        const record = await this.createKeylessDetachedSignature({
          publication_urn: input.publication_urn,
          logical_key: input.logical_key,
          signed_payload: signedPayload,
          envelope_sha256: digest,
          keyless_bundle: signature.keyless_bundle,
          signed_bytes: Buffer.from(message, 'utf8'),
          signer: signature.signer,
          errorPrefix: input.errorPrefix,
        });
        artifactUrns.push(record.artifact_urn);
        continue;
      }
      if (!signature.key_ref || !signature.algorithm || !signature.signature) {
        throw new RegistryCoreError(
          `${input.errorPrefix}_SIGNATURE_INVALID`,
          'Signatures require key_ref, algorithm, and signature (or a keyless bundle).',
        );
      }
      const material = await this.resolveTrustedPublicKeyMaterial(signature.key_ref);
      if (!material) {
        throw new RegistryCoreError(
          `${input.errorPrefix}_SIGNATURE_INVALID`,
          `Signature key ${signature.key_ref} is not a trusted public key.`,
        );
      }
      const verified = verifyDetachedSignatureBytes({
        algorithm: signature.algorithm,
        public_key_pem: material.public_key_pem,
        message,
        signature: signature.signature,
      });
      if (!verified) {
        throw new RegistryCoreError(
          `${input.errorPrefix}_SIGNATURE_INVALID`,
          'Detached signature failed cryptographic verification over the prepared envelope.',
        );
      }
      await this.enforceTrustedPublisherOnSignature({
        properties: input.candidate_properties,
        keyRef: signature.key_ref,
        errorCode: `${input.errorPrefix}_SIGNATURE_PUBLISHER_MISMATCH`,
      });
      const record = await this.createDetachedSignature({
        publication_urn: input.publication_urn,
        logical_key: input.logical_key,
        envelope_sha256: digest,
        signer: signature.signer,
        key_ref: signature.key_ref,
        algorithm: signature.algorithm,
        signature: signature.signature,
        signed_payload: signedPayload,
        ...(signature.transparency_log_ref ? { transparency_log_ref: signature.transparency_log_ref } : {}),
        ...(signature.inclusion_proof_ref ? { inclusion_proof_ref: signature.inclusion_proof_ref } : {}),
        ...(signature.inclusion_proof ? { inclusion_proof: signature.inclusion_proof } : {}),
      });
      artifactUrns.push(record.artifact_urn);
    }
    return artifactUrns;
  }

  private async buildGovernanceArtifactsForPublication(input: {
    entity_type: 'SKILL_VERSION' | 'AGENT_VERSION';
    logical_key: string;
    publication_urn: string;
    actor: string;
    policy_version: string;
    validation_report: string;
  }): Promise<import('../ports/registry-service.js').RegistryGovernanceArtifactRef[]> {
    const governanceArtifactDefs = buildDefaultGovernanceArtifacts({
      entity_type: input.entity_type,
      logical_key: input.logical_key,
      publication_urn: input.publication_urn,
      actor: input.actor,
      policy_version: input.policy_version,
      validation_report: input.validation_report,
    });
    const registeredPolicy = await this.findPolicyPackageNode(input.policy_version);
    const governanceArtifacts: import('../ports/registry-service.js').RegistryGovernanceArtifactRef[] = [];
    for (const definition of governanceArtifactDefs) {
      // Prefer the registered policy package artifact over the generated
      // placeholder when one exists for this policy version.
      if (definition.role === 'policy_package' && registeredPolicy) {
        governanceArtifacts.push({
          role: 'policy_package',
          artifact_urn: registeredPolicy.urn,
          ...(stringOrUndefined(registeredPolicy.properties['sha256'])
            ? { sha256: String(registeredPolicy.properties['sha256']) }
            : {}),
        });
        continue;
      }
      governanceArtifacts.push(
        await this.createGovernanceArtifact({
          role: definition.role,
          logical_key: input.logical_key,
          publication_urn: input.publication_urn,
          payload: definition.payload,
        }),
      );
    }
    return governanceArtifacts;
  }

  // Materializes the governance artifacts a prepared candidate referenced.
  // Placeholder artifacts are re-created (deterministically, so the URNs and
  // digests must match the candidate exactly); a registered policy package is
  // attached as-is. Divergence is treated as a stale candidate.
  private async materializePreparedGovernanceArtifacts(input: {
    entity_type: 'SKILL_VERSION' | 'AGENT_VERSION';
    logical_key: string;
    publication_urn: string;
    candidate: PreparedPublicationRecord['candidate'];
    properties: Record<string, unknown>;
    pinned_artifact_append_intents: PreparedPublicationRecord['pinned']['artifact_append_intents'];
    errorPrefix: 'SKILL_VERSION' | 'AGENT_VERSION';
  }): Promise<import('../ports/registry-service.js').RegistryGovernanceArtifactRef[]> {
    const stale = () =>
      new RegistryCoreError(
        `${input.errorPrefix}_PUBLISH_PREPARED_STALE`,
        'Prepared governance artifacts diverged from the current state; run prepare again and re-sign.',
      );
    const artifacts: import('../ports/registry-service.js').RegistryGovernanceArtifactRef[] = [];
    for (const ref of input.candidate.governance_artifacts) {
      const payloadEntry = input.candidate.governance_artifact_payloads.find(
        (entry) => entry.role === ref.role && entry.artifact_urn === ref.artifact_urn,
      );
      if (payloadEntry) {
        const pinnedIntent = input.pinned_artifact_append_intents.find(
          (entry) => entry.artifact_urn === ref.artifact_urn,
        );
        const created = await this.createGovernanceArtifact({
          role: ref.role,
          logical_key: input.logical_key,
          publication_urn: input.publication_urn,
          payload: payloadEntry.payload,
          append_intent: pinnedIntent ? pinnedIntent.intent : null,
        });
        if (created.artifact_urn !== ref.artifact_urn || created.sha256 !== ref.sha256) throw stale();
        artifacts.push(created);
        continue;
      }
      if (ref.role === 'policy_package') {
        const registered = await this.findPolicyPackageNode(String(input.properties['policy_version'] ?? ''));
        if (registered && registered.urn === ref.artifact_urn) {
          artifacts.push(ref);
          continue;
        }
      }
      // Pre-existing evidence refs (draft/validation artifacts) are already
      // attached and must not be re-attached or re-created.
    }
    return artifacts;
  }

  async createSkillDetachedSignature(input: { skill_key: string; version: number } & RegistryDetachedSignatureInput) {
    const version = await this.getSkillVersion(input);
    if (!version) {
      throw new RegistryCoreError('SKILL_VERSION_NOT_FOUND', 'Skill version not found.');
    }
    const currentStatus = lifecycleStatus(version.skill_version.properties);
    if (currentStatus !== 'published' && currentStatus !== 'certified' && currentStatus !== 'deprecated' && currentStatus !== 'revoked') {
      throw new RegistryCoreError('SKILL_SIGNATURE_CONFLICT', 'Only published, certified, deprecated, or revoked skill versions can receive detached signatures.');
    }
    const envelope = await this.getSkillPublicationEnvelope(input);
    if (!envelope) {
      throw new RegistryCoreError('SKILL_SIGNATURE_CONFLICT', 'Skill publication envelope not available.');
    }
    const signedPayload = input.signed_payload ?? 'canonical_json';
    if (signedPayload === 'canonical_rdf' && !envelope.canonical_rdf_sha256) {
      throw new RegistryCoreError('SKILL_SIGNATURE_CONFLICT', 'Canonical RDF is not available for this publication.');
    }
    if (input.keyless_bundle !== undefined) {
      if (signedPayload === 'canonical_rdf') {
        throw new RegistryCoreError(
          'SKILL_VERSION_KEYLESS_SIGNATURE_INVALID',
          'canonical_rdf keyless signatures must be attached through the prepared publication flow (signed payload bytes are required for verification).',
        );
      }
      return await this.createKeylessDetachedSignature({
        publication_urn: version.skill_version.urn,
        logical_key: input.skill_key,
        signed_payload: signedPayload,
        envelope_sha256: envelope.canonical_json_sha256,
        keyless_bundle: input.keyless_bundle,
        signed_bytes: Buffer.from(envelope.canonical_json, 'utf8'),
        signer: input.signer,
        errorPrefix: 'SKILL_VERSION',
      });
    }
    if (!input.key_ref || !input.algorithm || !input.signature) {
      throw new RegistryCoreError(
        'SKILL_SIGNATURE_CONFLICT',
        'Detached signatures require key_ref, algorithm, and signature (or a keyless bundle).',
      );
    }
    await this.enforceTrustedPublisherOnSignature({
      properties: version.skill_version.properties,
      keyRef: input.key_ref,
      errorCode: 'SKILL_VERSION_SIGNATURE_PUBLISHER_MISMATCH',
    });
    return await this.createDetachedSignature({
      publication_urn: version.skill_version.urn,
      logical_key: input.skill_key,
      envelope_sha256:
        signedPayload === 'canonical_rdf'
          ? (envelope.canonical_rdf_sha256 as string)
          : envelope.canonical_json_sha256,
      signer: input.signer,
      key_ref: input.key_ref,
      algorithm: input.algorithm,
      signature: input.signature,
      ...(input.signed_payload ? { signed_payload: input.signed_payload } : {}),
      ...(input.transparency_log_ref ? { transparency_log_ref: input.transparency_log_ref } : {}),
      ...(input.inclusion_proof_ref ? { inclusion_proof_ref: input.inclusion_proof_ref } : {}),
      ...(input.inclusion_proof ? { inclusion_proof: input.inclusion_proof } : {}),
    });
  }

  async createSkillDraft(input: CreateSkillDraftInput): Promise<RegistryOperationResult<RegistrySkillVersionDetails>> {
    const logical = await this.ensureLogicalSkill(input);
    const artifact = await this.deps.cas.put({
      bytes: decodeArtifactInput(input.artifact.content, input.artifact.encoding),
      ...(input.artifact.media_type ? { media_type: input.artifact.media_type } : {}),
      ...(input.artifact.original_path ? { original_path: input.artifact.original_path } : {}),
    });

    const matchingDraft = await this.findMatchingDraft(input.skill_key, {
      sha256: artifact.sha256,
      ...(input.commit_sha ? { commit_sha: input.commit_sha } : {}),
      ...(input.git_tag ? { git_tag: input.git_tag } : {}),
      ...(input.source_path ?? input.artifact.original_path
        ? { source_path: input.source_path ?? input.artifact.original_path }
        : {}),
    });
    if (matchingDraft) {
      const task = await this.createTask({
        operation: 'create_draft',
        author: input.author,
        target_urn: matchingDraft.skill_version.urn,
        skill_key: input.skill_key,
        version: getVersionNumber(matchingDraft.skill_version.properties),
        status: 'noop',
        ...(input.commit_sha ? { commit_sha: input.commit_sha } : {}),
        ...(input.git_tag ? { git_tag: input.git_tag } : {}),
        ...(input.artifact_signature ? { artifact_signature: input.artifact_signature } : {}),
        artifact_sha256: artifact.sha256,
      });
      return { task, result: matchingDraft };
    }

    const versions = await this.listSkillVersions({ skill_key: input.skill_key });
    const nextVersion = versions.versions.length > 0
      ? Math.max(...versions.versions.map((v) => getVersionNumber(v.skill_version.properties))) + 1
      : 1;
    const versionUrn = skillVersionUrn(input.skill_key, nextVersion);
    const source_path = input.source_path ?? input.artifact.original_path;

    await this.deps.graph.upsertNode({
      urn: versionUrn,
      entity_type: 'SKILL_VERSION',
      properties: {
        skill_key: input.skill_key,
        version: nextVersion,
        lifecycle_status: 'draft',
        certified: false,
        active: false,
        author: input.author,
        created_at: nowIso(),
        updated_at: nowIso(),
        artifact_sha256: artifact.sha256,
        ...(input.display_name ? { display_name: input.display_name } : {}),
        ...(input.description ? { description: input.description } : {}),
        ...(source_path ? { source_path } : {}),
        ...(input.commit_sha ? { commit_sha: input.commit_sha } : {}),
        ...(input.git_tag ? { git_tag: input.git_tag } : {}),
        ...(input.artifact_signature ? { artifact_signature: input.artifact_signature } : {}),
        ...(input.capability_claims?.length ? { capability_claims: input.capability_claims } : {}),
        ...(input.lineage ? { lineage: input.lineage } : {}),
        ...governanceInputHints(input.governance, input.artifact_signature),
      },
    });
    await this.deps.graph.upsertEdge({
      from_urn: logical.urn,
      to_urn: versionUrn,
      predicate: 'sg:hasVersion',
      properties: {},
    });
    if (nextVersion > 1) {
      // PROV-O derivation: this snapshot derives from the prior snapshot.
      await this.deps.graph.upsertEdge({
        from_urn: versionUrn,
        to_urn: skillVersionUrn(input.skill_key, nextVersion - 1),
        predicate: 'prov:wasDerivedFrom',
        properties: {},
      });
    }

    const artifactNodeUrn = artifactUrn(artifact.sha256);
    await this.deps.graph.upsertNode({
      urn: artifactNodeUrn,
      entity_type: 'ARTIFACT',
      properties: {
        sha256: artifact.sha256,
        size_bytes: artifact.size_bytes,
        ...(artifact.media_type ? { media_type: artifact.media_type } : {}),
        ...(artifact.original_path ? { original_path: artifact.original_path } : {}),
      },
    });
    await this.deps.graph.upsertEdge({
      from_urn: versionUrn,
      to_urn: artifactNodeUrn,
      predicate: 'sg:implementedBy',
      properties: {},
    });

    if (input.lineage?.upstream_skill_version_urns) {
      for (const upstream of input.lineage.upstream_skill_version_urns) {
        await this.deps.graph.upsertEdge({
          from_urn: versionUrn,
          to_urn: upstream,
          predicate: 'sg:dependsOnVersion',
          properties: {},
        });
      }
    }

    const details = await this.getSkillVersionByUrn(versionUrn);
    if (!details) {
      throw new RegistryCoreError('SKILL_VERSION_CREATE_FAILED', 'Failed to create skill draft.');
    }
    const task = await this.createTask({
      operation: 'create_draft',
      author: input.author,
      target_urn: versionUrn,
      skill_key: input.skill_key,
      version: nextVersion,
      status: 'completed',
      ...(input.commit_sha ? { commit_sha: input.commit_sha } : {}),
      ...(input.git_tag ? { git_tag: input.git_tag } : {}),
      ...(input.artifact_signature ? { artifact_signature: input.artifact_signature } : {}),
      artifact_sha256: artifact.sha256,
    });
    return { task, result: details };
  }

  private async runPublicationValidation(input: {
    entity_type: 'SKILL_VERSION' | 'AGENT_VERSION';
    logical_key: string;
    version_urn: string;
    properties: Record<string, unknown>;
  }): Promise<{ failures: string[]; violations: ValidationViolation[]; used_urns: string[] }> {
    const edges = await this.deps.graph.listEdgesFrom(input.version_urn);
    const dataEdges = [];
    for (const edge of edges) {
      const target = await this.deps.graph.getNode(edge.to_urn);
      dataEdges.push({
        predicate: edge.predicate,
        to_urn: edge.to_urn,
        ...(target ? { to_entity_type: target.entity_type as string } : {}),
      });
    }
    const dataGraph = {
      focus_urn: input.version_urn,
      entity_type: input.entity_type,
      properties: input.properties,
      edges: dataEdges,
    };

    // Layer 1: built-in graph-shape validation (structural rules), authored
    // as W3C SHACL Turtle and executed via the shared engine.
    const shaclEngine = resolveShaclEngine(this.deps.shaclExecution);
    const graphShapeViolations = await validatePublicationGraphWithTurtleShapes(
      { graph: dataGraph, shapes_turtle: BUILTIN_GRAPH_SHAPE_TURTLE },
      shaclEngine,
    );
    const layers: Array<Record<string, unknown>> = [
      {
        layer: 'graph_shape',
        shape_document: 'registry-graph-shape/builtin',
        shapes_format: 'shacl-turtle',
        shapes_sha256: BUILTIN_GRAPH_SHAPE_SHA256,
        violations: graphShapeViolations,
      },
    ];

    // Layer 2: W3C SHACL policy validation against the registered policy
    // package for this version's policy_version, when one is registered.
    // Legacy JSON documents execute through the translation path; authored
    // Turtle documents execute directly.
    const policyVersion = stringOrUndefined(input.properties['policy_version']) ?? 'registry-policy/v1';
    let policyViolations: ValidationViolation[] = [];
    let policyResolved = false;
    let policyShapesFormat: string | null = null;
    let policyShapesSha256: string | null = null;
    let policyEngineId: string | null = null;
    const policyNode = await this.findPolicyPackageNode(policyVersion);

    if (policyNode) {
      const sha = stringOrUndefined(policyNode.properties['sha256']);
      const stored = sha ? await this.deps.cas.getBySha256(sha) : null;
      if (stored) {
        try {
          const parsed = parsePolicyPackageEnvelope(
            JSON.parse(new TextDecoder('utf-8', { fatal: false }).decode(stored.bytes)),
          );
          if (parsed.shapes_turtle) {
            // SPARQL-feature policies run on the shacl-engine hybrid adapter;
            // core-only policies stay on the default engine.
            const policyEngine = await resolveTurtleShapesEngine(parsed.shapes_turtle, this.deps.shaclExecution);
            policyViolations = await validatePublicationGraphWithTurtleShapes(
              { graph: dataGraph, shapes_turtle: parsed.shapes_turtle },
              policyEngine,
            );
            policyEngineId = policyEngine.engine;
          } else if (parsed.document) {
            policyViolations = await validatePublicationGraphWithShacl(
              { graph: dataGraph, document: parsed.document },
              shaclEngine,
            );
          }
          policyResolved = true;
          policyShapesFormat = parsed.shapes_format;
          policyShapesSha256 = sha ?? null;
        } catch {
          policyResolved = false;
        }
      }
    }
    layers.push({
      layer: 'policy',
      policy_version: policyVersion,
      policy_package_resolved: policyResolved,
      ...(policyShapesFormat ? { shapes_format: policyShapesFormat } : {}),
      ...(policyShapesSha256 ? { shapes_sha256: policyShapesSha256 } : {}),
      ...(policyEngineId ? { engine: policyEngineId } : {}),
      violations: policyViolations,
    });

    // Layer 3: ontology validation. Capability claims must bind to known
    // concepts in the resolved normative skill-area ontology; unmapped
    // claims are recorded as de facto vocabulary candidates.
    const ontologyVersion = stringOrUndefined(input.properties['ontology_version']);
    const claims = Array.isArray(input.properties['capability_claims'])
      ? (input.properties['capability_claims'] as unknown[]).filter((claim): claim is string => typeof claim === 'string')
      : [];
    let ontologyViolations: ValidationViolation[] = [];
    let deFactoCandidates: string[] = [];
    let ontologyDocument: OntologyDocument | null = null;
    let ontologyNode = null;
    if (ontologyVersion) {
      ontologyNode = await this.findOntologyPackageNode(ontologyVersion);
      if (ontologyNode && ontologyNode.properties['ontology_kind'] === 'skill_area') {
        const sha = stringOrUndefined(ontologyNode.properties['sha256']);
        const stored = sha ? await this.deps.cas.getBySha256(sha) : null;
        if (stored) {
          try {
            const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: false }).decode(stored.bytes)) as {
              ontology?: unknown;
            };
            ontologyDocument = parseOntologyDocument(parsed.ontology);
            const result = validateCapabilityClaims({
              focus_urn: input.version_urn,
              claims,
              document: ontologyDocument,
              ontology_version: ontologyVersion,
            });
            ontologyViolations = result.violations;
            deFactoCandidates = result.de_facto_candidates;
          } catch {
            ontologyDocument = null;
          }
        }
      }
    }
    layers.push({
      layer: 'ontology',
      ontology_version: ontologyVersion ?? null,
      ontology_package_resolved: Boolean(ontologyDocument),
      capability_claims: claims,
      de_facto_candidates: deFactoCandidates,
      violations: ontologyViolations,
    });
    if (deFactoCandidates.length > 0) {
      await this.recordDeFactoCandidates(input.version_urn, deFactoCandidates);
    }

    // Layer 4: advisory LLM semantic validation. This layer is
    // evidence-producing only: findings are Warning-severity and never
    // contribute to validation failures or replace deterministic layers.
    let llmResult: LlmValidationResult | null = null;
    if (this.deps.llmValidator) {
      llmResult = await this.deps.llmValidator.validate({
        entity_type: input.entity_type,
        publication_urn: input.version_urn,
        ...(stringOrUndefined(input.properties['display_name'])
          ? { display_name: String(input.properties['display_name']) }
          : {}),
        ...(stringOrUndefined(input.properties['description'])
          ? { description: String(input.properties['description']) }
          : {}),
        capability_claims: claims,
        examples: Array.isArray(input.properties['examples'])
          ? (input.properties['examples'] as unknown[]).filter((item): item is string => typeof item === 'string')
          : [],
        known_concepts: ontologyDocument ? ontologyDocument.concepts.map((concept) => concept.id) : [],
      });
    }
    const llmWarnings: ValidationViolation[] = (llmResult?.warnings ?? []).map((warning) => ({
      focusNode: input.version_urn,
      resultPath: 'description',
      sourceConstraintComponent: 'LlmSemanticConstraintComponent',
      sourceShape: llmResult?.validator ?? 'llm',
      message: warning,
      severity: 'Warning' as const,
    }));
    layers.push({
      layer: 'llm_semantic',
      advisory: true,
      validator: llmResult?.validator ?? null,
      confidence: llmResult?.confidence ?? null,
      scorecards: llmResult?.scorecards ?? [],
      suggestions: llmResult?.suggestions ?? null,
      violations: llmWarnings,
    });

    const violations = [...graphShapeViolations, ...policyViolations, ...ontologyViolations];
    const failures = violations.filter((violation) => violation.severity === 'Violation').map((violation) => violation.message);

    // Every validation run emits a machine-readable report artifact with
    // per-layer violation paths, stored in the CAS and linked via
    // sg:validatedBy. Identical reports content-address to the same artifact.
    // The payload also carries a standardized sh:ValidationReport JSON-LD
    // representation with its own RDFC-1.0 canonical digest and artifact, so
    // reports are portable, offline-checkable RDF evidence.
    const validated_at = nowIso();
    const conforms = failures.length === 0;
    const reportExportInput = {
      focus_urn: input.version_urn,
      entity_type: input.entity_type,
      validated_at,
      validator: SHACL_VALIDATOR_ID,
      engine: shaclEngine.engine,
      conforms,
      layers: layers as ValidationReportLayer[],
    };
    const reportExport = await canonicalizeValidationReport(reportExportInput);
    await this.deps.cas.put({
      bytes: Buffer.from(reportExport.nquads, 'utf8'),
      media_type: 'application/n-quads',
      original_path: `validation-reports/${sanitizePathSegment(input.logical_key)}.nq`,
    });
    const reportArtifact = await this.createGovernanceArtifact({
      role: 'validation_report',
      logical_key: input.logical_key,
      publication_urn: input.version_urn,
      payload: {
        focus_urn: input.version_urn,
        entity_type: input.entity_type,
        validated_at,
        validator: SHACL_VALIDATOR_ID,
        engine: shaclEngine.engine,
        conforms,
        layers,
        rdf: {
          format: 'jsonld',
          canonical_rdf_sha256: reportExport.sha256,
          canonical_rdf_artifact_urn: artifactUrn(reportExport.sha256),
          report: projectValidationReportToJsonLd(reportExportInput),
        },
      },
    });
    await this.attachGovernanceArtifacts(input.version_urn, [reportArtifact]);

    // Transparency: the report's canonical RDF artifact gets a lightweight
    // node + version edge (sg:hasValidationReportRdf) + a best-effort append
    // intent, so reconciliation covers report RDF the same way it covers the
    // report JSON (via sg:validatedBy). Deliberately outside the envelope
    // governance refs: frozen-envelope bytes stay untouched.
    const reportRdfArtifactNodeUrn = artifactUrn(reportExport.sha256);
    await this.deps.graph.upsertNode({
      urn: reportRdfArtifactNodeUrn,
      entity_type: 'ARTIFACT',
      properties: {
        sha256: reportExport.sha256,
        governance_role: 'validation_report_rdf',
        publication_urn: input.version_urn,
      },
    });
    await this.deps.graph.upsertEdge({
      from_urn: input.version_urn,
      to_urn: reportRdfArtifactNodeUrn,
      predicate: 'sg:hasValidationReportRdf',
      properties: {},
    });
    await this.attachGovernanceArtifactAppendIntent({
      artifact_urn: reportRdfArtifactNodeUrn,
      role: 'validation_report_rdf',
      logical_key: input.logical_key,
      publication_urn: input.version_urn,
      sha256: reportExport.sha256,
      payload: { report_artifact_urn: reportArtifact.artifact_urn },
    });

    // LLM evidence artifact: scorecards, prompt, rationale, and
    // confidence, stored in the CAS and linked via sg:validatedBy.
    let llmEvidenceArtifactUrn: string | null = null;
    if (llmResult) {
      const llmEvidence = await this.createGovernanceArtifact({
        role: 'validation_report',
        logical_key: input.logical_key,
        publication_urn: input.version_urn,
        payload: {
          validator_kind: 'llm_semantic',
          validator: llmResult.validator,
          prompt: llmResult.prompt,
          scorecards: llmResult.scorecards,
          confidence: llmResult.confidence,
          suggestions: llmResult.suggestions,
          warnings: llmResult.warnings,
          advisory: true,
        },
      });
      await this.attachGovernanceArtifacts(input.version_urn, [llmEvidence]);
      llmEvidenceArtifactUrn = llmEvidence.artifact_urn;
    }

    const used_urns = [
      ...(policyNode ? [policyNode.urn] : []),
      ...(ontologyNode ? [ontologyNode.urn] : []),
      reportArtifact.artifact_urn,
      ...(llmEvidenceArtifactUrn ? [llmEvidenceArtifactUrn] : []),
    ];
    return { failures, violations, used_urns };
  }

  async validateSkillVersion(input: SkillVersionOperationInput): Promise<RegistryOperationResult<RegistrySkillVersionDetails>> {
    const version = await this.getRequiredSkillVersion(input.skill_key, input.version);
    const { failures, used_urns: validationUsedUrns } = await this.runPublicationValidation({
      entity_type: 'SKILL_VERSION',
      logical_key: input.skill_key,
      version_urn: version.skill_version.urn,
      properties: version.skill_version.properties,
    });
    if (failures.length > 0) {
      const currentStatus = lifecycleStatus(version.skill_version.properties);
      if (currentStatus === 'rejected') {
        const task = await this.createTask({
          operation: 'validate',
          author: input.author,
          target_urn: version.skill_version.urn,
          skill_key: input.skill_key,
          version: input.version,
          status: 'noop',
          validation_failures: failures.join(','),
          ...(input.note ? { note: input.note } : {}),
        });
        return { task, result: version };
      }
      if (currentStatus !== 'draft' && currentStatus !== 'validated') {
        throw new RegistryCoreError(
          'SKILL_VERSION_VALIDATE_CONFLICT',
          `Skill version cannot validate from status ${currentStatus}.`,
        );
      }
      await this.deps.graph.upsertNode({
        urn: version.skill_version.urn,
        entity_type: 'SKILL_VERSION',
        properties: {
          ...version.skill_version.properties,
          lifecycle_status: 'rejected',
          validation_status: 'failed',
          validation_failures: failures,
          updated_at: nowIso(),
        },
      });
      const rejected = await this.getRequiredSkillVersion(input.skill_key, input.version);
      const task = await this.createTask({
        operation: 'validate',
        author: input.author,
        target_urn: version.skill_version.urn,
        skill_key: input.skill_key,
        version: input.version,
        status: 'completed',
        validation_status: 'failed',
        validation_failures: failures.join(','),
        prov_used_urns: validationUsedUrns,
        ...(input.note ? { note: input.note } : {}),
      });
      return { task, result: rejected };
    }
    return await this.transitionSkillVersion({
      ...input,
      operation: 'validate',
      allowCurrentStatuses: ['validated', 'published', 'certified', 'deprecated'],
      nextStatus: 'validated',
      allowedFrom: ['draft', 'rejected'],
      provUsedUrns: validationUsedUrns,
    });
  }

  async publishSkillVersion(input: SkillVersionOperationInput): Promise<RegistryOperationResult<RegistrySkillVersionDetails>> {
    return await this.transitionSkillVersion({
      ...input,
      operation: 'publish',
      allowCurrentStatuses: ['published'],
      nextStatus: 'published',
      allowedFrom: ['draft', 'validated'],
      activateIfMissing: true,
    });
  }

  async promoteSkillVersion(input: SkillVersionOperationInput): Promise<RegistryOperationResult<RegistrySkillVersionDetails>> {
    const version = await this.getRequiredSkillVersion(input.skill_key, input.version);
    const currentStatus = lifecycleStatus(version.skill_version.properties);
    if (currentStatus !== 'published' && currentStatus !== 'certified') {
      throw new RegistryCoreError('SKILL_VERSION_PROMOTE_CONFLICT', 'Only published or certified versions can be promoted.');
    }

    const active = await this.getActiveSkillVersion({ skill_key: input.skill_key });
    if (active?.skill_version.urn === version.skill_version.urn) {
      const task = await this.createTask({
        operation: 'promote',
        author: input.author,
        target_urn: version.skill_version.urn,
        skill_key: input.skill_key,
        version: input.version,
        status: 'noop',
        ...(input.note ? { note: input.note } : {}),
      });
      return { task, result: version };
    }

    // Supersession guard: only a currently trusted (published or certified)
    // snapshot may be superseded. Revoked snapshots must never be marked
    // superseded, and a certified snapshot is only superseded here by a
    // newer trusted (published/certified) replacement.
    if (active) {
      const activeStatus = lifecycleStatus(active.skill_version.properties);
      if (activeStatus === 'published' || activeStatus === 'certified') {
        await this.deps.graph.upsertNode({
          urn: active.skill_version.urn,
          entity_type: 'SKILL_VERSION',
          properties: {
            ...active.skill_version.properties,
            publication_status: 'superseded',
            superseded_by_version_urn: version.skill_version.urn,
            superseded_at: nowIso(),
            active: false,
          },
        });
        await this.deps.graph.upsertEdge({
          from_urn: version.skill_version.urn,
          to_urn: active.skill_version.urn,
          predicate: 'sg:supersedesVersion',
          properties: {},
        });
      }
    }

    await this.setActiveVersion(input.skill_key, version.skill_version.urn);
    const updated = await this.getRequiredSkillVersion(input.skill_key, input.version);
    const task = await this.createTask({
      operation: 'promote',
      author: input.author,
      target_urn: version.skill_version.urn,
      skill_key: input.skill_key,
      version: input.version,
      status: 'completed',
      ...(input.note ? { note: input.note } : {}),
    });
    return { task, result: updated };
  }

  async deprecateSkillVersion(input: SkillVersionOperationInput): Promise<RegistryOperationResult<RegistrySkillVersionDetails>> {
    const result = await this.transitionSkillVersion({
      ...input,
      operation: 'deprecate',
      allowCurrentStatuses: ['deprecated'],
      nextStatus: 'deprecated',
      allowedFrom: ['draft', 'validated', 'published', 'certified'],
      clearActiveIfTarget: true,
    });
    return result;
  }

  async revokeSkillVersion(input: SkillVersionOperationInput): Promise<RegistryOperationResult<RegistrySkillVersionDetails>> {
    const version = await this.getRequiredSkillVersion(input.skill_key, input.version);
    const currentStatus = lifecycleStatus(version.skill_version.properties);
    if (currentStatus === 'revoked') {
      const task = await this.createTask({
        operation: 'revoke',
        author: input.author,
        target_urn: version.skill_version.urn,
        skill_key: input.skill_key,
        version: input.version,
        status: 'noop',
        ...(input.note ? { note: input.note } : {}),
      });
      return { task, result: version };
    }
    if (currentStatus !== 'published' && currentStatus !== 'certified' && currentStatus !== 'deprecated') {
      throw new RegistryCoreError('SKILL_VERSION_REVOKE_CONFLICT', 'Only published, certified, or deprecated versions can be revoked.');
    }

    await this.deps.graph.upsertNode({
      urn: version.skill_version.urn,
      entity_type: 'SKILL_VERSION',
      properties: {
        ...version.skill_version.properties,
        lifecycle_status: 'revoked',
        publication_status: 'revoked',
        revoked: true,
        revoked_at: nowIso(),
        revoked_by: input.author,
        ...(input.note ? { revocation_reason: input.note } : {}),
        active: false,
        updated_at: nowIso(),
      },
    });

    const active = await this.getActiveSkillVersion({ skill_key: input.skill_key });
    if (active?.skill_version.urn === version.skill_version.urn) {
      await this.clearActiveVersion(input.skill_key);
    }

    const updated = await this.getRequiredSkillVersion(input.skill_key, input.version);
    const task = await this.createTask({
      operation: 'revoke',
      author: input.author,
      target_urn: version.skill_version.urn,
      skill_key: input.skill_key,
      version: input.version,
      status: 'completed',
      ...(input.note ? { note: input.note } : {}),
      ...(input.governance?.publisher ? { publisher: input.governance.publisher } : {}),
      ...(input.governance?.policy_version ? { policy_version: input.governance.policy_version } : {}),
      ...(input.governance?.validation_report ? { validation_report: input.governance.validation_report } : {}),
      ...(input.governance?.signature_ref ? { signature_ref: input.governance.signature_ref } : {}),
      ...(input.governance?.approver ? { approved_by: input.governance.approver } : {}),
      ...(input.governance?.approver_role ? { approved_role: input.governance.approver_role } : {}),
    });
    return { task, result: updated };
  }

  async certifySkillVersion(input: SkillVersionOperationInput): Promise<RegistryOperationResult<RegistrySkillVersionDetails>> {
    const version = await this.getRequiredSkillVersion(input.skill_key, input.version);
    const currentStatus = lifecycleStatus(version.skill_version.properties);
    if (currentStatus !== 'published') {
      if (currentStatus === 'certified' || version.skill_version.properties['certified'] === true) {
        const task = await this.createTask({
          operation: 'certify',
          author: input.author,
          target_urn: version.skill_version.urn,
          skill_key: input.skill_key,
          version: input.version,
          status: 'noop',
          ...(input.note ? { note: input.note } : {}),
        });
        return { task, result: version };
      }
      throw new RegistryCoreError('SKILL_VERSION_CERTIFY_CONFLICT', 'Only published versions can be certified.');
    }
    if (input.governance?.ontology_version) {
      const ontologyNode = await this.findOntologyPackageNode(input.governance.ontology_version);
      if (!ontologyNode) {
        throw new RegistryCoreError(
          'ONTOLOGY_PACKAGE_NOT_FOUND',
          `Ontology package not found: ${input.governance.ontology_version}`,
        );
      }
    }
    await this.enforceHumanReviewGate({
      properties: version.skill_version.properties,
      errorCode: 'SKILL_VERSION_CERTIFY_CONFLICT',
      action: 'certify',
    });
    await this.enforcePublicationTrustGates({
      publication_urn: version.skill_version.urn,
      properties: version.skill_version.properties,
      operation: 'certify',
      errorCodePrefix: 'SKILL_VERSION',
      verification: await this.getSkillPublicationVerification({
        skill_key: input.skill_key,
        version: input.version,
      }),
    });

    const publication = ensureSkillGovernanceReady({
      version,
      actor: input.author,
      ...(input.governance ? { governance: input.governance } : {}),
      ...(input.note ? { note: input.note } : {}),
    });
    const certificationPolicyVersion =
      input.governance?.policy_version ?? stringOrUndefined(publication.properties['policy_version']) ?? 'registry-policy/v1';
    const certificationArtifact = await this.createGovernanceArtifact({
      role: 'certification_evidence',
      logical_key: input.skill_key,
      publication_urn: version.skill_version.urn,
      payload: {
        certification_note: input.note ?? '',
        certified_by: input.author,
        approved_by: input.governance?.approver ?? input.author,
        approved_role: input.governance?.approver_role ?? 'certifier',
        policy_version: certificationPolicyVersion,
        ...(input.governance?.ontology_version ? { ontology_version: input.governance.ontology_version } : {}),
        ...(input.governance?.certification_expires_at
          ? { certification_expires_at: input.governance.certification_expires_at }
          : {}),
      },
    });

    await this.deps.graph.upsertNode({
      urn: version.skill_version.urn,
      entity_type: 'SKILL_VERSION',
      properties: {
        ...version.skill_version.properties,
        ...publication.properties,
        lifecycle_status: 'certified',
        certified: true,
        certified_by: input.author,
        certified_at: nowIso(),
        certification_policy_version: certificationPolicyVersion,
        ...(input.governance?.ontology_version
          ? { certification_ontology_version: input.governance.ontology_version }
          : {}),
        ...(input.governance?.certification_expires_at
          ? { certification_expires_at: input.governance.certification_expires_at }
          : {}),
        ...(input.note ? { certification_note: input.note } : {}),
        ...(input.governance?.approver_role ? { certified_role: input.governance.approver_role } : {}),
        updated_at: nowIso(),
      },
    });
    await this.attachGovernanceArtifacts(version.skill_version.urn, [certificationArtifact]);
    await this.recordPublicationAppendIntent({
      publication_urn: version.skill_version.urn,
      logical_key: input.skill_key,
      entity_type: 'SKILL_VERSION',
      note: 'skill certification publication state',
    });
    // Certification is a governance checkpoint that changes the published
    // graph (certification evidence); re-project the canonical RDF so the
    // recorded semantic digest reflects the certified state.
    {
      const certifiedNode = await this.deps.graph.getNode(version.skill_version.urn);
      if (certifiedNode) {
        const canonicalRdf = await this.publishCanonicalRdfArtifact({
          publication_urn: version.skill_version.urn,
          logical_urn: skillUrn(input.skill_key),
          properties: Object.fromEntries(
            Object.entries(certifiedNode.properties).filter(
              ([propKey]) => propKey !== 'canonical_rdf_sha256' && propKey !== 'canonical_rdf_artifact_urn',
            ),
          ),
        });
        await this.deps.graph.upsertNode({
          urn: certifiedNode.urn,
          entity_type: certifiedNode.entity_type,
          properties: {
            ...certifiedNode.properties,
            canonical_rdf_sha256: canonicalRdf.sha256,
            canonical_rdf_artifact_urn: canonicalRdf.artifact_urn,
          },
        });
      }
    }
    const certifyUsedUrns: string[] = [certificationArtifact.artifact_urn];
    const certificationPolicyNode = await this.findPolicyPackageNode(certificationPolicyVersion);
    if (certificationPolicyNode) certifyUsedUrns.push(certificationPolicyNode.urn);
    if (input.governance?.ontology_version) {
      const ontologyNode = await this.findOntologyPackageNode(input.governance.ontology_version);
      if (ontologyNode) certifyUsedUrns.push(ontologyNode.urn);
    }
    const approver = input.governance?.approver;
    const updated = await this.getRequiredSkillVersion(input.skill_key, input.version);
    const task = await this.createTask({
      operation: 'certify',
      author: input.author,
      target_urn: version.skill_version.urn,
      skill_key: input.skill_key,
      version: input.version,
      status: 'completed',
      prov_used_urns: certifyUsedUrns,
      ...(approver && approver !== input.author
        ? { prov_associated_agents: [{ agent: approver, role: input.governance?.approver_role ?? 'certifier' }] }
        : {}),
      ...(input.note ? { note: input.note } : {}),
      ...publication.taskEvidence,
    });
    return { task, result: updated };
  }

  async archiveSkillVersion(input: SkillVersionOperationInput): Promise<RegistryOperationResult<RegistrySkillVersionDetails>> {
    const version = await this.getRequiredSkillVersion(input.skill_key, input.version);
    const currentStatus = lifecycleStatus(version.skill_version.properties);
    if (currentStatus === 'archived') {
      const task = await this.createTask({
        operation: 'archive',
        author: input.author,
        target_urn: version.skill_version.urn,
        skill_key: input.skill_key,
        version: input.version,
        status: 'noop',
        ...(input.note ? { note: input.note } : {}),
      });
      return { task, result: version };
    }
    // Terminal retention state: reachable from revoked, or from a
    // published/certified snapshot that has been superseded.
    const superseded = version.skill_version.properties['publication_status'] === 'superseded';
    const archivable =
      currentStatus === 'revoked' ||
      ((currentStatus === 'published' || currentStatus === 'certified') && superseded);
    if (!archivable) {
      throw new RegistryCoreError(
        'SKILL_VERSION_ARCHIVE_CONFLICT',
        `Skill version cannot archive from status ${currentStatus}.`,
      );
    }

    await this.deps.graph.upsertNode({
      urn: version.skill_version.urn,
      entity_type: 'SKILL_VERSION',
      properties: {
        ...version.skill_version.properties,
        lifecycle_status: 'archived',
        archived_at: nowIso(),
        archived_by: input.author,
        active: false,
        updated_at: nowIso(),
      },
    });
    const active = await this.getActiveSkillVersion({ skill_key: input.skill_key });
    if (active?.skill_version.urn === version.skill_version.urn) {
      await this.clearActiveVersion(input.skill_key);
    }

    const updated = await this.getRequiredSkillVersion(input.skill_key, input.version);
    const task = await this.createTask({
      operation: 'archive',
      author: input.author,
      target_urn: version.skill_version.urn,
      skill_key: input.skill_key,
      version: input.version,
      status: 'completed',
      ...(input.note ? { note: input.note } : {}),
    });
    return { task, result: updated };
  }


  private async getRequiredAgentVersion(agentKey: string, version: number): Promise<RegistryAgentVersionDetails> {
    const got = await this.getAgentVersion({ agent_key: agentKey, version });
    if (!got) {
      throw new RegistryCoreError('AGENT_VERSION_NOT_FOUND', `Agent version not found: ${agentKey}@v${version}`);
    }
    return got;
  }

  private async ensureLogicalAgent(input: {
    agent_key: string;
    display_name?: string;
    description?: string;
    source_path?: string;
  }) {
    const agentNodeUrn = agentUrn(input.agent_key);
    const existing = await this.deps.graph.getNode(agentNodeUrn);
    if (existing) return existing;

    await this.deps.graph.upsertNode({
      urn: agentNodeUrn,
      entity_type: 'AGENT',
      properties: {
        agent_key: input.agent_key,
        ...(input.display_name ? { display_name: input.display_name } : {}),
        ...(input.description ? { description: input.description } : {}),
        ...(input.source_path ? { source_path: input.source_path } : {}),
      },
    });

    const created = await this.deps.graph.getNode(agentNodeUrn);
    if (!created) {
      throw new RegistryCoreError('AGENT_CREATE_FAILED', 'Failed to create logical agent.');
    }
    return created;
  }

  private async setActiveAgentVersion(agentKey: string, versionUrn: string): Promise<void> {
    const logicalAgent = await this.ensureLogicalAgent({ agent_key: agentKey });
    await this.deps.graph.upsertNode({
      urn: logicalAgent.urn,
      entity_type: 'AGENT',
      properties: {
        ...logicalAgent.properties,
        active_version_urn: versionUrn,
      },
    });

    const versions = await this.listAgentVersions({ agent_key: agentKey });
    for (const version of versions.versions) {
      await this.deps.graph.upsertNode({
        urn: version.agent_version.urn,
        entity_type: 'AGENT_VERSION',
        properties: {
          ...version.agent_version.properties,
          active: version.agent_version.urn === versionUrn,
        },
      });
    }
  }

  private async clearActiveAgentVersion(agentKey: string): Promise<void> {
    const logicalAgent = await this.ensureLogicalAgent({ agent_key: agentKey });
    const props = { ...logicalAgent.properties };
    delete props['active_version_urn'];
    await this.deps.graph.upsertNode({
      urn: logicalAgent.urn,
      entity_type: 'AGENT',
      properties: props,
    });

    const versions = await this.listAgentVersions({ agent_key: agentKey });
    for (const version of versions.versions) {
      await this.deps.graph.upsertNode({
        urn: version.agent_version.urn,
        entity_type: 'AGENT_VERSION',
        properties: {
          ...version.agent_version.properties,
          active: false,
        },
      });
    }
  }

  private async findMatchingAgentDraft(
    agentKey: string,
    input: { sha256: string; commit_sha?: string; git_tag?: string; source_path?: string },
  ): Promise<RegistryAgentVersionDetails | null> {
    const versions = await this.listAgentVersions({ agent_key: agentKey });
    return (
      versions.versions.find((version) => {
        const props = version.agent_version.properties;
        return (
          lifecycleStatus(props) === 'draft' &&
          stringOrUndefined(props['artifact_sha256']) === input.sha256 &&
          stringOrUndefined(props['commit_sha']) === input.commit_sha &&
          stringOrUndefined(props['git_tag']) === input.git_tag &&
          stringOrUndefined(props['source_path']) === input.source_path
        );
      }) ?? null
    );
  }

  async createAgentDraft(input: CreateAgentDraftInput): Promise<RegistryOperationResult<RegistryAgentVersionDetails>> {
    const logical = await this.ensureLogicalAgent(input);
    // Dependency validation: linked skills must resolve to existing skills
    // before the draft snapshot may declare them.
    const normalizedSkillRefs = await this.resolveAndValidateSkillRefs(input.skill_refs);
    const artifact = await this.deps.cas.put({
      bytes: decodeArtifactInput(input.artifact.content, input.artifact.encoding),
      ...(input.artifact.media_type ? { media_type: input.artifact.media_type } : {}),
      ...(input.artifact.original_path ? { original_path: input.artifact.original_path } : {}),
    });

    const matchingDraft = await this.findMatchingAgentDraft(input.agent_key, {
      sha256: artifact.sha256,
      ...(input.commit_sha ? { commit_sha: input.commit_sha } : {}),
      ...(input.git_tag ? { git_tag: input.git_tag } : {}),
      ...(input.source_path ?? input.artifact.original_path
        ? { source_path: input.source_path ?? input.artifact.original_path }
        : {}),
    });
    if (matchingDraft) {
      const task = await this.createTask({
        operation: 'create_draft',
        author: input.author,
        target_urn: matchingDraft.agent_version.urn,
        agent_key: input.agent_key,
        version: getVersionNumber(matchingDraft.agent_version.properties),
        status: 'noop',
        ...(input.commit_sha ? { commit_sha: input.commit_sha } : {}),
        ...(input.git_tag ? { git_tag: input.git_tag } : {}),
        ...(input.artifact_signature ? { artifact_signature: input.artifact_signature } : {}),
        artifact_sha256: artifact.sha256,
      });
      return { task, result: matchingDraft };
    }

    const versions = await this.listAgentVersions({ agent_key: input.agent_key });
    const nextVersion = versions.versions.length > 0
      ? Math.max(...versions.versions.map((v) => getVersionNumber(v.agent_version.properties))) + 1
      : 1;
    const versionUrn = agentVersionUrn(input.agent_key, nextVersion);
    const source_path = input.source_path ?? input.artifact.original_path;

    await this.deps.graph.upsertNode({
      urn: versionUrn,
      entity_type: 'AGENT_VERSION',
      properties: {
        agent_key: input.agent_key,
        version: nextVersion,
        lifecycle_status: 'draft',
        active: false,
        created_at: nowIso(),
        updated_at: nowIso(),
        artifact_sha256: artifact.sha256,
        ...(input.display_name ? { display_name: input.display_name } : {}),
        ...(input.description ? { description: input.description } : {}),
        ...(source_path ? { source_path } : {}),
        ...(input.commit_sha ? { commit_sha: input.commit_sha } : {}),
        ...(input.git_tag ? { git_tag: input.git_tag } : {}),
        ...(input.artifact_signature ? { artifact_signature: input.artifact_signature } : {}),
        ...(input.capability_claims?.length ? { capability_claims: input.capability_claims } : {}),
        ...governanceInputHints(input.governance, input.artifact_signature),
      },
    });
    await this.deps.graph.upsertEdge({
      from_urn: logical.urn,
      to_urn: versionUrn,
      predicate: 'sg:hasVersion',
      properties: {},
    });
    if (nextVersion > 1) {
      // PROV-O derivation: this snapshot derives from the prior snapshot.
      await this.deps.graph.upsertEdge({
        from_urn: versionUrn,
        to_urn: agentVersionUrn(input.agent_key, nextVersion - 1),
        predicate: 'prov:wasDerivedFrom',
        properties: {},
      });
    }

    const artifactNodeUrn = artifactUrn(artifact.sha256);
    await this.deps.graph.upsertNode({
      urn: artifactNodeUrn,
      entity_type: 'ARTIFACT',
      properties: {
        sha256: artifact.sha256,
        size_bytes: artifact.size_bytes,
        ...(artifact.media_type ? { media_type: artifact.media_type } : {}),
        ...(artifact.original_path ? { original_path: artifact.original_path } : {}),
      },
    });
    await this.deps.graph.upsertEdge({
      from_urn: versionUrn,
      to_urn: artifactNodeUrn,
      predicate: 'sg:definedBy',
      properties: {},
    });

    if (normalizedSkillRefs) {
      for (const ref of normalizedSkillRefs) {
        await this.deps.graph.upsertEdge({
          from_urn: versionUrn,
          to_urn: ref.skill_urn,
          predicate: 'sg:usesSkill',
          properties: {},
        });
      }
    }

    const details = await this.getAgentVersionByUrn(versionUrn);
    if (!details) {
      throw new RegistryCoreError('AGENT_VERSION_CREATE_FAILED', 'Failed to create agent draft.');
    }
    const task = await this.createTask({
      operation: 'create_draft',
      author: input.author,
      target_urn: versionUrn,
      agent_key: input.agent_key,
      version: nextVersion,
      status: 'completed',
      ...(input.commit_sha ? { commit_sha: input.commit_sha } : {}),
      ...(input.git_tag ? { git_tag: input.git_tag } : {}),
      ...(input.artifact_signature ? { artifact_signature: input.artifact_signature } : {}),
      artifact_sha256: artifact.sha256,
    });
    return { task, result: details };
  }

  async validateAgentVersion(input: AgentVersionOperationInput): Promise<RegistryOperationResult<RegistryAgentVersionDetails>> {
    const version = await this.getRequiredAgentVersion(input.agent_key, input.version);
    const { failures, used_urns: validationUsedUrns } = await this.runPublicationValidation({
      entity_type: 'AGENT_VERSION',
      logical_key: input.agent_key,
      version_urn: version.agent_version.urn,
      properties: version.agent_version.properties,
    });
    if (failures.length > 0) {
      const currentStatus = lifecycleStatus(version.agent_version.properties);
      if (currentStatus === 'rejected') {
        const task = await this.createTask({
          operation: 'validate',
          author: input.author,
          target_urn: version.agent_version.urn,
          agent_key: input.agent_key,
          version: input.version,
          status: 'noop',
          validation_failures: failures.join(','),
          ...(input.note ? { note: input.note } : {}),
        });
        return { task, result: version };
      }
      if (currentStatus !== 'draft' && currentStatus !== 'validated') {
        throw new RegistryCoreError(
          'AGENT_VERSION_VALIDATE_CONFLICT',
          `Agent version cannot validate from status ${currentStatus}.`,
        );
      }
      await this.deps.graph.upsertNode({
        urn: version.agent_version.urn,
        entity_type: 'AGENT_VERSION',
        properties: {
          ...version.agent_version.properties,
          lifecycle_status: 'rejected',
          validation_status: 'failed',
          validation_failures: failures,
          updated_at: nowIso(),
        },
      });
      const rejected = await this.getRequiredAgentVersion(input.agent_key, input.version);
      const task = await this.createTask({
        operation: 'validate',
        author: input.author,
        target_urn: version.agent_version.urn,
        agent_key: input.agent_key,
        version: input.version,
        status: 'completed',
        validation_status: 'failed',
        validation_failures: failures.join(','),
        prov_used_urns: validationUsedUrns,
        ...(input.note ? { note: input.note } : {}),
      });
      return { task, result: rejected };
    }
    return await this.transitionAgentVersion({
      ...input,
      operation: 'validate',
      allowCurrentStatuses: ['validated', 'published', 'certified', 'deprecated'],
      nextStatus: 'validated',
      allowedFrom: ['draft', 'rejected'],
      provUsedUrns: validationUsedUrns,
    });
  }

  async publishAgentVersion(input: AgentVersionOperationInput): Promise<RegistryOperationResult<RegistryAgentVersionDetails>> {
    return await this.transitionAgentVersion({
      ...input,
      operation: 'publish',
      allowCurrentStatuses: ['published'],
      nextStatus: 'published',
      allowedFrom: ['draft', 'validated'],
      activateIfMissing: true,
    });
  }

  async promoteAgentVersion(input: AgentVersionOperationInput): Promise<RegistryOperationResult<RegistryAgentVersionDetails>> {
    const version = await this.getRequiredAgentVersion(input.agent_key, input.version);
    const currentStatus = lifecycleStatus(version.agent_version.properties);
    if (currentStatus !== 'published' && currentStatus !== 'certified') {
      throw new RegistryCoreError('AGENT_VERSION_PROMOTE_CONFLICT', 'Only published or certified versions can be promoted.');
    }

    const active = await this.getActiveAgentVersion({ agent_key: input.agent_key });
    if (active?.agent_version.urn === version.agent_version.urn) {
      const task = await this.createTask({
        operation: 'promote',
        author: input.author,
        target_urn: version.agent_version.urn,
        agent_key: input.agent_key,
        version: input.version,
        status: 'noop',
        ...(input.note ? { note: input.note } : {}),
      });
      return { task, result: version };
    }

    // Supersession guard: only a currently trusted (published or certified)
    // snapshot may be superseded; revoked snapshots must never be superseded.
    if (active) {
      const activeStatus = lifecycleStatus(active.agent_version.properties);
      if (activeStatus === 'published' || activeStatus === 'certified') {
        await this.deps.graph.upsertNode({
          urn: active.agent_version.urn,
          entity_type: 'AGENT_VERSION',
          properties: {
            ...active.agent_version.properties,
            publication_status: 'superseded',
            superseded_by_version_urn: version.agent_version.urn,
            superseded_at: nowIso(),
            active: false,
          },
        });
        await this.deps.graph.upsertEdge({
          from_urn: version.agent_version.urn,
          to_urn: active.agent_version.urn,
          predicate: 'sg:supersedesVersion',
          properties: {},
        });
      }
    }

    await this.setActiveAgentVersion(input.agent_key, version.agent_version.urn);
    const updated = await this.getRequiredAgentVersion(input.agent_key, input.version);
    const task = await this.createTask({
      operation: 'promote',
      author: input.author,
      target_urn: version.agent_version.urn,
      agent_key: input.agent_key,
      version: input.version,
      status: 'completed',
      ...(input.note ? { note: input.note } : {}),
    });
    return { task, result: updated };
  }

  async deprecateAgentVersion(input: AgentVersionOperationInput): Promise<RegistryOperationResult<RegistryAgentVersionDetails>> {
    return await this.transitionAgentVersion({
      ...input,
      operation: 'deprecate',
      allowCurrentStatuses: ['deprecated'],
      nextStatus: 'deprecated',
      allowedFrom: ['draft', 'validated', 'published', 'certified'],
      clearActiveIfTarget: true,
    });
  }

  async revokeAgentVersion(input: AgentVersionOperationInput): Promise<RegistryOperationResult<RegistryAgentVersionDetails>> {
    const version = await this.getRequiredAgentVersion(input.agent_key, input.version);
    const currentStatus = lifecycleStatus(version.agent_version.properties);
    if (currentStatus === 'revoked') {
      const task = await this.createTask({
        operation: 'revoke',
        author: input.author,
        target_urn: version.agent_version.urn,
        agent_key: input.agent_key,
        version: input.version,
        status: 'noop',
        ...(input.note ? { note: input.note } : {}),
      });
      return { task, result: version };
    }
    if (currentStatus !== 'published' && currentStatus !== 'certified' && currentStatus !== 'deprecated') {
      throw new RegistryCoreError('AGENT_VERSION_REVOKE_CONFLICT', 'Only published, certified, or deprecated versions can be revoked.');
    }

    await this.deps.graph.upsertNode({
      urn: version.agent_version.urn,
      entity_type: 'AGENT_VERSION',
      properties: {
        ...version.agent_version.properties,
        lifecycle_status: 'revoked',
        publication_status: 'revoked',
        revoked: true,
        revoked_at: nowIso(),
        revoked_by: input.author,
        ...(input.note ? { revocation_reason: input.note } : {}),
        active: false,
        updated_at: nowIso(),
      },
    });

    const active = await this.getActiveAgentVersion({ agent_key: input.agent_key });
    if (active?.agent_version.urn === version.agent_version.urn) {
      await this.clearActiveAgentVersion(input.agent_key);
    }

    const updated = await this.getRequiredAgentVersion(input.agent_key, input.version);
    const task = await this.createTask({
      operation: 'revoke',
      author: input.author,
      target_urn: version.agent_version.urn,
      agent_key: input.agent_key,
      version: input.version,
      status: 'completed',
      ...(input.note ? { note: input.note } : {}),
      ...(input.governance?.publisher ? { publisher: input.governance.publisher } : {}),
      ...(input.governance?.policy_version ? { policy_version: input.governance.policy_version } : {}),
      ...(input.governance?.validation_report ? { validation_report: input.governance.validation_report } : {}),
      ...(input.governance?.signature_ref ? { signature_ref: input.governance.signature_ref } : {}),
      ...(input.governance?.approver ? { approved_by: input.governance.approver } : {}),
      ...(input.governance?.approver_role ? { approved_role: input.governance.approver_role } : {}),
    });
    return { task, result: updated };
  }

  async certifyAgentVersion(input: AgentVersionOperationInput): Promise<RegistryOperationResult<RegistryAgentVersionDetails>> {
    const version = await this.getRequiredAgentVersion(input.agent_key, input.version);
    const currentStatus = lifecycleStatus(version.agent_version.properties);
    if (currentStatus !== 'published') {
      if (currentStatus === 'certified' || version.agent_version.properties['certified'] === true) {
        const task = await this.createTask({
          operation: 'certify',
          author: input.author,
          target_urn: version.agent_version.urn,
          agent_key: input.agent_key,
          version: input.version,
          status: 'noop',
          ...(input.note ? { note: input.note } : {}),
        });
        return { task, result: version };
      }
      throw new RegistryCoreError('AGENT_VERSION_CERTIFY_CONFLICT', 'Only published versions can be certified.');
    }
    if (input.governance?.ontology_version) {
      const ontologyNode = await this.findOntologyPackageNode(input.governance.ontology_version);
      if (!ontologyNode) {
        throw new RegistryCoreError(
          'ONTOLOGY_PACKAGE_NOT_FOUND',
          `Ontology package not found: ${input.governance.ontology_version}`,
        );
      }
    }
    await this.enforceHumanReviewGate({
      properties: version.agent_version.properties,
      errorCode: 'AGENT_VERSION_CERTIFY_CONFLICT',
      action: 'certify',
    });
    await this.enforcePublicationTrustGates({
      publication_urn: version.agent_version.urn,
      properties: version.agent_version.properties,
      operation: 'certify',
      errorCodePrefix: 'AGENT_VERSION',
      verification: await this.getAgentPublicationVerification({
        agent_key: input.agent_key,
        version: input.version,
      }),
    });

    const publication = ensureAgentGovernanceReady({
      version,
      actor: input.author,
      ...(input.governance ? { governance: input.governance } : {}),
      ...(input.note ? { note: input.note } : {}),
    });
    const certificationPolicyVersion =
      input.governance?.policy_version ?? stringOrUndefined(publication.properties['policy_version']) ?? 'registry-policy/v1';
    const certificationArtifact = await this.createGovernanceArtifact({
      role: 'certification_evidence',
      logical_key: input.agent_key,
      publication_urn: version.agent_version.urn,
      payload: {
        certification_note: input.note ?? '',
        certified_by: input.author,
        approved_by: input.governance?.approver ?? input.author,
        approved_role: input.governance?.approver_role ?? 'certifier',
        policy_version: certificationPolicyVersion,
        ...(input.governance?.ontology_version ? { ontology_version: input.governance.ontology_version } : {}),
        ...(input.governance?.certification_expires_at
          ? { certification_expires_at: input.governance.certification_expires_at }
          : {}),
      },
    });

    await this.deps.graph.upsertNode({
      urn: version.agent_version.urn,
      entity_type: 'AGENT_VERSION',
      properties: {
        ...version.agent_version.properties,
        ...publication.properties,
        lifecycle_status: 'certified',
        certified: true,
        certified_by: input.author,
        certified_at: nowIso(),
        certification_policy_version: certificationPolicyVersion,
        ...(input.governance?.ontology_version
          ? { certification_ontology_version: input.governance.ontology_version }
          : {}),
        ...(input.governance?.certification_expires_at
          ? { certification_expires_at: input.governance.certification_expires_at }
          : {}),
        ...(input.note ? { certification_note: input.note } : {}),
        ...(input.governance?.approver_role ? { certified_role: input.governance.approver_role } : {}),
        updated_at: nowIso(),
      },
    });
    await this.attachGovernanceArtifacts(version.agent_version.urn, [certificationArtifact]);
    await this.recordPublicationAppendIntent({
      publication_urn: version.agent_version.urn,
      logical_key: input.agent_key,
      entity_type: 'AGENT_VERSION',
      note: 'agent certification publication state',
    });
    // Certification is a governance checkpoint that changes the published
    // graph (certification evidence); re-project the canonical RDF so the
    // recorded semantic digest reflects the certified state.
    {
      const certifiedNode = await this.deps.graph.getNode(version.agent_version.urn);
      if (certifiedNode) {
        const canonicalRdf = await this.publishCanonicalRdfArtifact({
          publication_urn: version.agent_version.urn,
          logical_urn: agentUrn(input.agent_key),
          properties: Object.fromEntries(
            Object.entries(certifiedNode.properties).filter(
              ([propKey]) => propKey !== 'canonical_rdf_sha256' && propKey !== 'canonical_rdf_artifact_urn',
            ),
          ),
        });
        await this.deps.graph.upsertNode({
          urn: certifiedNode.urn,
          entity_type: certifiedNode.entity_type,
          properties: {
            ...certifiedNode.properties,
            canonical_rdf_sha256: canonicalRdf.sha256,
            canonical_rdf_artifact_urn: canonicalRdf.artifact_urn,
          },
        });
      }
    }
    const certifyUsedUrns: string[] = [certificationArtifact.artifact_urn];
    const certificationPolicyNode = await this.findPolicyPackageNode(certificationPolicyVersion);
    if (certificationPolicyNode) certifyUsedUrns.push(certificationPolicyNode.urn);
    if (input.governance?.ontology_version) {
      const ontologyNode = await this.findOntologyPackageNode(input.governance.ontology_version);
      if (ontologyNode) certifyUsedUrns.push(ontologyNode.urn);
    }
    const approver = input.governance?.approver;
    const updated = await this.getRequiredAgentVersion(input.agent_key, input.version);
    const task = await this.createTask({
      operation: 'certify',
      author: input.author,
      target_urn: version.agent_version.urn,
      agent_key: input.agent_key,
      version: input.version,
      status: 'completed',
      prov_used_urns: certifyUsedUrns,
      ...(approver && approver !== input.author
        ? { prov_associated_agents: [{ agent: approver, role: input.governance?.approver_role ?? 'certifier' }] }
        : {}),
      ...(input.note ? { note: input.note } : {}),
      ...publication.taskEvidence,
    });
    return { task, result: updated };
  }

  async archiveAgentVersion(input: AgentVersionOperationInput): Promise<RegistryOperationResult<RegistryAgentVersionDetails>> {
    const version = await this.getRequiredAgentVersion(input.agent_key, input.version);
    const currentStatus = lifecycleStatus(version.agent_version.properties);
    if (currentStatus === 'archived') {
      const task = await this.createTask({
        operation: 'archive',
        author: input.author,
        target_urn: version.agent_version.urn,
        agent_key: input.agent_key,
        version: input.version,
        status: 'noop',
        ...(input.note ? { note: input.note } : {}),
      });
      return { task, result: version };
    }
    // Terminal retention state: reachable from revoked, or from a
    // published/certified snapshot that has been superseded.
    const superseded = version.agent_version.properties['publication_status'] === 'superseded';
    const archivable =
      currentStatus === 'revoked' ||
      ((currentStatus === 'published' || currentStatus === 'certified') && superseded);
    if (!archivable) {
      throw new RegistryCoreError(
        'AGENT_VERSION_ARCHIVE_CONFLICT',
        `Agent version cannot archive from status ${currentStatus}.`,
      );
    }

    await this.deps.graph.upsertNode({
      urn: version.agent_version.urn,
      entity_type: 'AGENT_VERSION',
      properties: {
        ...version.agent_version.properties,
        lifecycle_status: 'archived',
        archived_at: nowIso(),
        archived_by: input.author,
        active: false,
        updated_at: nowIso(),
      },
    });
    const active = await this.getActiveAgentVersion({ agent_key: input.agent_key });
    if (active?.agent_version.urn === version.agent_version.urn) {
      await this.clearActiveAgentVersion(input.agent_key);
    }

    const updated = await this.getRequiredAgentVersion(input.agent_key, input.version);
    const task = await this.createTask({
      operation: 'archive',
      author: input.author,
      target_urn: version.agent_version.urn,
      agent_key: input.agent_key,
      version: input.version,
      status: 'completed',
      ...(input.note ? { note: input.note } : {}),
    });
    return { task, result: updated };
  }

  private async transitionAgentVersion(input: AgentVersionOperationInput & {
    operation: RegistryOperationKind;
    allowCurrentStatuses: RegistryLifecycleStatus[];
    nextStatus: RegistryLifecycleStatus;
    allowedFrom?: RegistryLifecycleStatus[];
    activateIfMissing?: boolean;
    clearActiveIfTarget?: boolean;
    provUsedUrns?: string[];
  }): Promise<RegistryOperationResult<RegistryAgentVersionDetails>> {
    const version = await this.getRequiredAgentVersion(input.agent_key, input.version);
    const currentStatus = lifecycleStatus(version.agent_version.properties);

    if (input.allowCurrentStatuses.includes(currentStatus)) {
      const task = await this.createTask({
        operation: input.operation,
        author: input.author,
        target_urn: version.agent_version.urn,
        agent_key: input.agent_key,
        version: input.version,
        status: 'noop',
        ...(input.note ? { note: input.note } : {}),
      });
      return { task, result: version };
    }

    if (input.allowedFrom && !input.allowedFrom.includes(currentStatus)) {
      throw new RegistryCoreError(
        `AGENT_VERSION_${input.operation.toUpperCase()}_CONFLICT`,
        `Agent version cannot ${input.operation} from status ${currentStatus}.`,
      );
    }

    if (input.operation === 'publish') {
      await this.enforceHumanReviewGate({
        properties: version.agent_version.properties,
        errorCode: 'AGENT_VERSION_PUBLISH_CONFLICT',
        action: 'publish',
      });
      await this.enforcePublicationTrustGates({
        publication_urn: version.agent_version.urn,
        properties: version.agent_version.properties,
        operation: 'publish',
        errorCodePrefix: 'AGENT_VERSION',
      });
    }
    let publishUsedUrns: string[] = [];
    let preparedRecord: PreparedPublicationRecord | null = null;
    if (input.operation === 'publish' && input.prepared_publication_urn) {
      preparedRecord = await this.loadPreparedPublicationRecord({
        prepared_publication_urn: input.prepared_publication_urn,
        expected_publication_urn: version.agent_version.urn,
        errorPrefix: 'AGENT_VERSION',
      });
      await this.verifyPreparedPublicationRecord({
        record: preparedRecord,
        entity_type: 'AGENT_VERSION',
        logical_key: input.agent_key,
        logical_urn: agentUrn(input.agent_key),
        publication_urn: version.agent_version.urn,
        version_properties: version.agent_version.properties,
        artifacts: version.artifacts,
        author: input.author,
        ...(input.note ? { note: input.note } : {}),
        ...(input.governance ? { governance: input.governance } : {}),
        activate_if_missing: true,
        errorPrefix: 'AGENT_VERSION',
      });
      if (input.signatures && input.signatures.length > 0) {
        await this.validatePreparedPublicationSignatures({
          logical_key: input.agent_key,
          candidate: preparedRecord.candidate,
          signatures: input.signatures,
          errorPrefix: 'AGENT_VERSION',
        });
      }
    }
    if (input.operation === 'publish' && !preparedRecord && input.signatures && input.signatures.length > 0) {
      throw new RegistryCoreError(
        'AGENT_VERSION_SIGNATURES_REQUIRE_PREPARED',
        'Detached signatures at publish require a prepared publication.',
      );
    }
    const publication =
      input.operation === 'publish'
        ? preparedRecord
          ? {
              properties: preparedRecord.candidate.properties,
              taskEvidence: taskEvidenceFromPublicationProperties(preparedRecord.candidate.properties),
            }
          : ensureAgentGovernanceReady({
              version,
              actor: input.author,
              ...(input.governance ? { governance: input.governance } : {}),
              ...(input.note ? { note: input.note } : {}),
            })
        : undefined;

    const updatedProps = preparedRecord
      ? { ...preparedRecord.candidate.properties }
      : {
          ...version.agent_version.properties,
          ...(publication?.properties ?? {}),
          lifecycle_status: input.nextStatus,
          updated_at: nowIso(),
        };
    await this.deps.graph.upsertNode({
      urn: version.agent_version.urn,
      entity_type: 'AGENT_VERSION',
      properties: updatedProps,
    });

    if (input.activateIfMissing) {
      const active = await this.getActiveAgentVersion({ agent_key: input.agent_key });
      if (!active) {
        await this.setActiveAgentVersion(input.agent_key, version.agent_version.urn);
      }
    }

    if (input.operation === 'publish' && publication) {
      const governanceArtifacts = preparedRecord
        ? await this.materializePreparedGovernanceArtifacts({
            entity_type: 'AGENT_VERSION',
            logical_key: input.agent_key,
            publication_urn: version.agent_version.urn,
            candidate: preparedRecord.candidate,
            properties: preparedRecord.candidate.properties,
            pinned_artifact_append_intents: preparedRecord.pinned.artifact_append_intents,
            errorPrefix: 'AGENT_VERSION',
          })
        : await this.buildGovernanceArtifactsForPublication({
            entity_type: 'AGENT_VERSION',
            logical_key: input.agent_key,
            publication_urn: version.agent_version.urn,
            actor: publication.properties['publisher'] as string,
            policy_version: publication.properties['policy_version'] as string,
            validation_report: publication.properties['validation_report'] as string,
          });
      await this.attachGovernanceArtifacts(version.agent_version.urn, governanceArtifacts);
      publishUsedUrns = governanceArtifacts.map((artifact) => artifact.artifact_urn);
      if (!preparedRecord?.pinned.append_intent) {
        await this.recordPublicationAppendIntent({
          publication_urn: version.agent_version.urn,
          logical_key: input.agent_key,
          entity_type: 'AGENT_VERSION',
          note: 'agent publication',
        });
      }
      // Canonical RDF (RDFC-1.0) projection of the published graph for
      // semantic signatures, stored as a CAS artifact with its digest
      // recorded on the version.
      // Project from the current node state (post-activation), not the
      // stale pre-publish property set, so the recorded semantic digest
      // matches later re-projection at verification time.
      const projectionNode = await this.deps.graph.getNode(version.agent_version.urn);
      const canonicalRdf = await this.publishCanonicalRdfArtifact({
        publication_urn: version.agent_version.urn,
        logical_urn: agentUrn(input.agent_key),
        properties: projectionNode?.properties ?? updatedProps,
      });
      const nodeWithRdf = await this.deps.graph.getNode(version.agent_version.urn);
      if (nodeWithRdf) {
        await this.deps.graph.upsertNode({
          urn: nodeWithRdf.urn,
          entity_type: nodeWithRdf.entity_type,
          properties: {
            ...nodeWithRdf.properties,
            canonical_rdf_sha256: canonicalRdf.sha256,
            canonical_rdf_artifact_urn: canonicalRdf.artifact_urn,
          },
        });
      }
      // Freeze the publication envelope bytes as a CAS artifact. The frozen
      // payload is what the publication envelope endpoint serves from here
      // on, so later evidence attachment cannot invalidate signatures.
      const frozenEnvelope = await this.freezePublicationEnvelope({
        publication_urn: version.agent_version.urn,
        entity_type: 'AGENT_VERSION',
        logical_key: input.agent_key,
      });
      if (frozenEnvelope) publishUsedUrns.push(frozenEnvelope.artifact_urn);
      if (
        preparedRecord &&
        frozenEnvelope &&
        frozenEnvelope.sha256 !== preparedRecord.candidate.canonical_json_sha256
      ) {
        throw new RegistryCoreError(
          'AGENT_VERSION_PUBLISH_PREPARED_STALE',
          'Frozen envelope diverged from the prepared candidate.',
        );
      }
      if (preparedRecord && input.signatures && input.signatures.length > 0) {
        const signatureUrns = await this.attachPublicationSignatures({
          publication_urn: version.agent_version.urn,
          logical_key: input.agent_key,
          candidate: preparedRecord.candidate,
          candidate_properties: preparedRecord.candidate.properties,
          signatures: input.signatures,
          errorPrefix: 'AGENT_VERSION',
        });
        publishUsedUrns.push(...signatureUrns);
      }
    }

    if (input.clearActiveIfTarget) {
      const active = await this.getActiveAgentVersion({ agent_key: input.agent_key });
      if (active?.agent_version.urn === version.agent_version.urn) {
        await this.clearActiveAgentVersion(input.agent_key);
      }
    }

    const result = await this.getRequiredAgentVersion(input.agent_key, input.version);
    const task = await this.createTask({
      operation: input.operation,
      author: input.author,
      target_urn: version.agent_version.urn,
      agent_key: input.agent_key,
      version: input.version,
      status: 'completed',
      prov_used_urns: [...(input.provUsedUrns ?? []), ...publishUsedUrns],
      ...(input.note ? { note: input.note } : {}),
      ...(publication?.taskEvidence ?? {}),
    });
    return { task, result };
  }

  private async enforceTrustedPublisherOnSignature(input: {
    properties: Record<string, unknown>;
    keyRef: string;
    errorCode: string;
  }): Promise<void> {
    const bound = await this.readBoundPolicyDocument(input.properties);
    if (bound?.parsed.gates.require_trusted_publisher !== true) return;
    const material = await this.resolveTrustedPublicKeyMaterial(input.keyRef);
    const trustedKey = await this.getTrustedPublicKey({ key_ref: input.keyRef });
    const owner = stringOrUndefined(trustedKey?.public_key.properties['owner']);
    const publisher = stringOrUndefined(input.properties['publisher']);
    if (!material || !owner || !publisher || owner !== publisher) {
      throw new RegistryCoreError(
        input.errorCode,
        `Policy ${bound.policyVersion} requires signatures from a trusted key owned by the publication publisher.`,
      );
    }
  }

  private async readBoundPolicyDocument(
    properties: Record<string, unknown>,
  ): Promise<{ policyVersion: string; parsed: import('./policy-package-envelope.js').ParsedPolicyPackageEnvelope } | null> {
    const policyVersion = stringOrUndefined(properties['policy_version']) ?? 'registry-policy/v1';
    const policyNode = await this.findPolicyPackageNode(policyVersion);
    if (!policyNode) return null;
    const sha = stringOrUndefined(policyNode.properties['sha256']);
    const stored = sha ? await this.deps.cas.getBySha256(sha) : null;
    if (!stored) return null;
    try {
      const parsed = parsePolicyPackageEnvelope(
        JSON.parse(new TextDecoder('utf-8', { fatal: false }).decode(stored.bytes)),
      );
      return { policyVersion, parsed };
    } catch {
      return null;
    }
  }

  private async enforceHumanReviewGate(input: {
    properties: Record<string, unknown>;
    errorCode: string;
    action: string;
  }) {
    const bound = await this.readBoundPolicyDocument(input.properties);
    if (!bound) return;
    if (bound.parsed.gates.require_human_review === true && input.properties['review_status'] !== 'approved') {
      throw new RegistryCoreError(
        input.errorCode,
        `Human review approval is required by policy ${bound.policyVersion} before ${input.action}.`,
      );
    }
  }

  // Policy-driven trust gates. `require_validation` binds at publish and
  // certify; the evidence-backed gates (signature, trusted publisher, build
  // provenance, SBOM) bind at certify, where the frozen envelope is serveable
  // and evidence attached after publish is available.
  private async enforcePublicationTrustGates(input: {
    publication_urn: string;
    properties: Record<string, unknown>;
    operation: 'publish' | 'certify';
    errorCodePrefix: 'SKILL_VERSION' | 'AGENT_VERSION';
    verification?: RegistryPublicationVerification | null;
  }): Promise<void> {
    const bound = await this.readBoundPolicyDocument(input.properties);
    if (!bound) return;
    const { policyVersion } = bound;
    const gates = bound.parsed.gates;

    // A version that is still a draft has never passed validation; validated
    // status is the durable signal (publish itself stamps validation_status).
    if (gates.require_validation === true && input.operation === 'publish') {
      if (lifecycleStatus(input.properties) === 'draft') {
        throw new RegistryCoreError(
          `${input.errorCodePrefix}_VALIDATION_REQUIRED`,
          `Policy ${policyVersion} requires validation before publish.`,
        );
      }
    }

    if (input.operation !== 'certify') return;

    const attestations = input.verification?.attestations ?? [];
    if (gates.require_build_provenance === true) {
      const hasProvenance = attestations.some((attestation) =>
        BUILD_PROVENANCE_PREDICATE_TYPES.has(attestation.predicate_type.trim().toLowerCase()),
      );
      if (!hasProvenance) {
        throw new RegistryCoreError(
          `${input.errorCodePrefix}_BUILD_PROVENANCE_REQUIRED`,
          `Policy ${policyVersion} requires a verified build-provenance attestation before certify.`,
        );
      }
    }
    if (gates.require_sbom === true) {
      const hasSbom = attestations.some((attestation) =>
        SBOM_PREDICATE_TYPES.has(attestation.predicate_type.trim().toLowerCase()),
      );
      if (!hasSbom) {
        throw new RegistryCoreError(
          `${input.errorCodePrefix}_SBOM_REQUIRED`,
          `Policy ${policyVersion} requires a verified SBOM attestation before certify.`,
        );
      }
    }

    const needsSignatures = gates.require_signature === true || gates.require_trusted_publisher === true;
    if (!needsSignatures) return;
    const validChecks = (input.verification?.signature_checks ?? []).filter(
      (check) =>
        check.cryptographic_verification_passed &&
        check.envelope_sha256_matches &&
        (check.trusted_public_key_resolved ||
          (check.signature_kind === 'keyless' && check.keyless?.verified === true)),
    );
    if (gates.require_signature === true && validChecks.length === 0) {
      throw new RegistryCoreError(
        `${input.errorCodePrefix}_SIGNATURE_REQUIRED`,
        `Policy ${policyVersion} requires at least one verified detached signature before certify.`,
      );
    }
    if (gates.require_trusted_publisher === true) {
      const publisher = stringOrUndefined(input.properties['publisher']);
      let publisherMatched = false;
      if (publisher) {
        for (const check of validChecks) {
          const trustedKey = await this.getTrustedPublicKey({ key_ref: check.key_ref });
          const owner = stringOrUndefined(trustedKey?.public_key.properties['owner']);
          if (owner && owner === publisher) {
            publisherMatched = true;
            break;
          }
        }
      }
      if (!publisherMatched) {
        throw new RegistryCoreError(
          `${input.errorCodePrefix}_TRUSTED_PUBLISHER_REQUIRED`,
          `Policy ${policyVersion} requires a verified signature from a trusted key owned by publisher ${publisher ?? '(unset)'} before certify.`,
        );
      }
    }
  }

  private async reviewVersion(input: {
    entity_type: 'SKILL_VERSION' | 'AGENT_VERSION';
    logical_key: string;
    version_urn: string;
    properties: Record<string, unknown>;
    author: string;
    decision: 'approve' | 'reject';
    review_role?: string;
    note?: string;
  }): Promise<Record<string, unknown>> {
    const currentStatus = lifecycleStatus(input.properties);
    if (currentStatus !== 'validated' && currentStatus !== 'published') {
      throw new RegistryCoreError(
        `${input.entity_type === 'SKILL_VERSION' ? 'SKILL' : 'AGENT'}_VERSION_REVIEW_CONFLICT`,
        `Only validated or published versions can be reviewed (current: ${currentStatus}).`,
      );
    }
    const reviewStatus = input.decision === 'approve' ? 'approved' : 'rejected';
    const reviewArtifact = await this.createGovernanceArtifact({
      role: 'review_evidence',
      logical_key: input.logical_key,
      publication_urn: input.version_urn,
      payload: {
        decision: input.decision,
        reviewer: input.author,
        review_role: input.review_role ?? 'reviewer',
        review_note: input.note ?? '',
        reviewed_at: nowIso(),
        domain: input.entity_type,
      },
    });
    await this.attachGovernanceArtifacts(input.version_urn, [reviewArtifact]);
    return {
      review_status: reviewStatus,
      reviewed_by: input.author,
      reviewed_at: nowIso(),
      review_role: input.review_role ?? 'reviewer',
      ...(input.note ? { review_note: input.note } : {}),
    };
  }

  async reviewSkillVersion(
    input: SkillVersionOperationInput & import('../ports/registry-service.js').RegistryReviewInput,
  ): Promise<RegistryOperationResult<RegistrySkillVersionDetails>> {
    const version = await this.getRequiredSkillVersion(input.skill_key, input.version);
    const reviewProps = await this.reviewVersion({
      entity_type: 'SKILL_VERSION',
      logical_key: input.skill_key,
      version_urn: version.skill_version.urn,
      properties: version.skill_version.properties,
      author: input.author,
      decision: input.decision,
      ...(input.review_role ? { review_role: input.review_role } : {}),
      ...(input.note ? { note: input.note } : {}),
    });
    await this.deps.graph.upsertNode({
      urn: version.skill_version.urn,
      entity_type: 'SKILL_VERSION',
      properties: {
        ...version.skill_version.properties,
        ...reviewProps,
        updated_at: nowIso(),
      },
    });
    const updated = await this.getRequiredSkillVersion(input.skill_key, input.version);
    const task = await this.createTask({
      operation: 'review',
      author: input.author,
      target_urn: version.skill_version.urn,
      skill_key: input.skill_key,
      version: input.version,
      status: 'completed',
      ...(input.note ? { note: input.note } : {}),
      ...(input.review_role ? { approved_role: input.review_role } : {}),
    });
    return { task, result: updated };
  }

  async reviewAgentVersion(
    input: AgentVersionOperationInput & import('../ports/registry-service.js').RegistryReviewInput,
  ): Promise<RegistryOperationResult<RegistryAgentVersionDetails>> {
    const version = await this.getRequiredAgentVersion(input.agent_key, input.version);
    const reviewProps = await this.reviewVersion({
      entity_type: 'AGENT_VERSION',
      logical_key: input.agent_key,
      version_urn: version.agent_version.urn,
      properties: version.agent_version.properties,
      author: input.author,
      decision: input.decision,
      ...(input.review_role ? { review_role: input.review_role } : {}),
      ...(input.note ? { note: input.note } : {}),
    });
    await this.deps.graph.upsertNode({
      urn: version.agent_version.urn,
      entity_type: 'AGENT_VERSION',
      properties: {
        ...version.agent_version.properties,
        ...reviewProps,
        updated_at: nowIso(),
      },
    });
    const updated = await this.getRequiredAgentVersion(input.agent_key, input.version);
    const task = await this.createTask({
      operation: 'review',
      author: input.author,
      target_urn: version.agent_version.urn,
      agent_key: input.agent_key,
      version: input.version,
      status: 'completed',
      ...(input.note ? { note: input.note } : {}),
      ...(input.review_role ? { approved_role: input.review_role } : {}),
    });
    return { task, result: updated };
  }

  async listPendingReviews(): Promise<{ pending: import('../ports/registry-service.js').RegistryPendingReviewItem[] }> {
    const pending: import('../ports/registry-service.js').RegistryPendingReviewItem[] = [];
    for (const entityType of ['SKILL_VERSION', 'AGENT_VERSION'] as const) {
      const nodes = await this.deps.graph.listNodesByType(entityType);
      for (const node of nodes) {
        const status = lifecycleStatus(node.properties);
        if (status !== 'validated' && status !== 'published') continue;
        if (node.properties['review_status'] === 'approved') continue;
        pending.push({
          publication_urn: node.urn,
          entity_type: entityType,
          logical_key:
            stringOrUndefined(node.properties['skill_key']) ?? stringOrUndefined(node.properties['agent_key']) ?? '',
          lifecycle_status: status,
          review_status: stringOrUndefined(node.properties['review_status']) ?? 'pending',
          ...(stringOrUndefined(node.properties['policy_version'])
            ? { policy_version: String(node.properties['policy_version']) }
            : {}),
        });
      }
    }
    pending.sort((left, right) => left.publication_urn.localeCompare(right.publication_urn));
    return { pending };
  }

  async getArtifact(input: { sha256?: string; artifact_urn?: string }): Promise<RegistryArtifactDetails | null> {
    const sha256 = input.sha256 ?? parseArtifactSha256(input.artifact_urn ?? '');
    if (!sha256) {
      return null;
    }

    const got = await this.readCasArtifact(sha256);
    if (!got) {
      return null;
    }

    const media_type = await this.resolveArtifactMediaType(sha256, got.record.media_type);
    return {
      sha256,
      size_bytes: got.record.size_bytes,
      content: new TextDecoder('utf-8', { fatal: false }).decode(got.bytes),
      content_truncated: false,
      digest_verified: got.digest_verified,
      ...(media_type ? { media_type } : {}),
    };
  }

  async getArtifactBytes(input: { sha256?: string; artifact_urn?: string }): Promise<RegistryArtifactBytes | null> {
    const sha256 = input.sha256 ?? parseArtifactSha256(input.artifact_urn ?? '');
    if (!sha256) {
      return null;
    }

    const got = await this.readCasArtifact(sha256);
    if (!got) {
      return null;
    }

    const media_type = await this.resolveArtifactMediaType(sha256, got.record.media_type);
    return {
      sha256,
      size_bytes: got.record.size_bytes,
      bytes: got.bytes,
      digest_verified: got.digest_verified,
      ...(media_type ? { media_type } : {}),
    };
  }

  async getArtifactReferences(input: {
    artifact_urn: string;
  }): Promise<{ references: RegistryArtifactReference[] } | null> {
    const artifactNode = await this.deps.graph.getNode(input.artifact_urn);
    if (!artifactNode || artifactNode.entity_type !== 'ARTIFACT') {
      return null;
    }

    const referencingEdges = await this.deps.graph.listEdgesTo(artifactNode.urn);
    const references: RegistryArtifactReference[] = [];
    const seen = new Set<string>();
    for (const edge of referencingEdges) {
      const from = edge.from_urn;
      if (!from.startsWith('urn:sg:skill-version:') && !from.startsWith('urn:sg:agent-version:')) {
        continue;
      }
      if (seen.has(from)) continue;
      const node = await this.deps.graph.getNode(from);
      if (!node || (node.entity_type !== 'SKILL_VERSION' && node.entity_type !== 'AGENT_VERSION')) {
        continue;
      }
      seen.add(from);
      references.push({
        publication_urn: node.urn,
        entity_type: node.entity_type,
        revoked: node.properties['revoked'] === true || lifecycleStatus(node.properties) === 'revoked',
      });
    }
    references.sort((left, right) => left.publication_urn.localeCompare(right.publication_urn));
    return { references };
  }

  // Ingests a DSSE/in-toto attestation as publication evidence: the signature
  // is verified over the DSSE PAE bytes against a trusted key, the statement's
  // predicate type is recorded, subjects (when present) must match an artifact
  // of this publication, and only successfully verified evidence is stored.
  async attachAttestation(input: RegistryAttestationInput): Promise<{ attestation: RegistryAttestationRecord }> {
    const publication = await this.deps.graph.getNode(input.publication_urn);
    if (!publication || (publication.entity_type !== 'SKILL_VERSION' && publication.entity_type !== 'AGENT_VERSION')) {
      throw new RegistryCoreError('ATTESTATION_PUBLICATION_NOT_FOUND', 'Publication version not found.');
    }
    const status = lifecycleStatus(publication.properties);
    if (status !== 'published' && status !== 'certified' && status !== 'deprecated' && status !== 'revoked') {
      throw new RegistryCoreError(
        'ATTESTATION_CONFLICT',
        'Only published, certified, deprecated, or revoked versions can receive attestations.',
      );
    }

    const resolvedKey = await this.resolveTrustedPublicKeyMaterial(input.key_ref);
    if (!resolvedKey) {
      throw new RegistryCoreError(
        'ATTESTATION_TRUSTED_KEY_NOT_FOUND',
        `Trusted public key not available for ${input.key_ref}.`,
      );
    }

    const payloadBytes = Buffer.from(input.envelope.payload, 'base64');
    const payloadText = payloadBytes.toString('utf8');
    let statement: Record<string, unknown>;
    try {
      const parsed = JSON.parse(payloadText);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('not an object');
      }
      statement = parsed as Record<string, unknown>;
    } catch {
      throw new RegistryCoreError('ATTESTATION_PAYLOAD_INVALID', 'DSSE payload must be a JSON in-toto statement.');
    }

    const predicateType = stringOrUndefined(statement['predicateType']) ?? stringOrUndefined(input.predicate_type);
    if (!predicateType) {
      throw new RegistryCoreError(
        'ATTESTATION_PREDICATE_TYPE_REQUIRED',
        'Attestation predicate type is required (in-toto statement predicateType or predicate_type input).',
      );
    }

    const primarySignature = input.envelope.signatures[0];
    if (!primarySignature || !primarySignature.sig) {
      throw new RegistryCoreError('ATTESTATION_SIGNATURE_INVALID', 'DSSE envelope carries no signatures.');
    }
    let signatureValid = false;
    try {
      signatureValid = verifyDetachedSignatureBytes({
        algorithm: input.algorithm,
        public_key_pem: resolvedKey.public_key_pem,
        message: dssePae(input.envelope.payload_type, payloadText, payloadBytes.byteLength),
        signature: primarySignature.sig,
      });
    } catch {
      // Unsupported encodings and malformed keys are invalid signatures, not
      // internal errors.
      signatureValid = false;
    }
    if (!signatureValid) {
      throw new RegistryCoreError(
        'ATTESTATION_SIGNATURE_INVALID',
        'DSSE signature did not verify against the trusted key.',
      );
    }

    const subjectDigests = collectAttestationSubjectSha256(statement);
    const version =
      publication.entity_type === 'SKILL_VERSION'
        ? await this.getSkillVersionByUrn(publication.urn)
        : await this.getAgentVersionByUrn(publication.urn);
    const artifactDigests = new Set(
      (version?.artifacts ?? []).map((artifact) => artifact.sha256).filter((value): value is string => Boolean(value)),
    );
    let subjectBound = false;
    if (subjectDigests.length > 0) {
      subjectBound = subjectDigests.some((digest) => artifactDigests.has(digest));
      if (!subjectBound) {
        throw new RegistryCoreError(
          'ATTESTATION_SUBJECT_MISMATCH',
          'Attestation subjects do not match any artifact of this publication.',
        );
      }
    }

    const attachedAt = nowIso();
    const logicalKey = extractLogicalKeyFromPublicationUrn(publication.urn);
    const content = canonicalJsonString({
      envelope: {
        payload_type: input.envelope.payload_type,
        payload: input.envelope.payload,
        signatures: input.envelope.signatures,
      },
      signer: input.signer,
      key_ref: input.key_ref,
      algorithm: input.algorithm,
      predicate_type: predicateType,
      signature_valid: true,
      subject_bound: subjectBound,
      subject_digests: subjectDigests,
      attached_at: attachedAt,
      ...(input.note ? { note: input.note } : {}),
    });
    const artifact = await this.deps.cas.put({
      bytes: Buffer.from(content, 'utf8'),
      media_type: 'application/json',
      original_path: `generated/attestation/${sanitizePathSegment(logicalKey)}.json`,
    });
    const artifactNodeUrn = artifactUrn(artifact.sha256);
    await this.deps.graph.upsertNode({
      urn: artifactNodeUrn,
      entity_type: 'ARTIFACT',
      properties: {
        sha256: artifact.sha256,
        size_bytes: artifact.size_bytes,
        media_type: artifact.media_type,
        original_path: artifact.original_path,
        governance_role: 'attestation',
        signer: input.signer,
        key_ref: input.key_ref,
        algorithm: input.algorithm,
        predicate_type: predicateType,
        signature_valid: true,
        subject_bound: subjectBound,
        subject_digests: subjectDigests,
        attached_at: attachedAt,
        ...(input.note ? { note: input.note } : {}),
      },
    });
    await this.deps.graph.upsertEdge({
      from_urn: publication.urn,
      to_urn: artifactNodeUrn,
      predicate: 'sg:attestedBy',
      properties: {},
    });
    return {
      attestation: {
        artifact_urn: artifactNodeUrn,
        sha256: artifact.sha256,
        signer: input.signer,
        key_ref: input.key_ref,
        algorithm: input.algorithm,
        predicate_type: predicateType,
        signature_valid: true,
        subject_bound: subjectBound,
        subject_digests: subjectDigests,
        attached_at: attachedAt,
      },
    };
  }

  async listAttestations(input: {
    publication_urn: string;
  }): Promise<{ attestations: RegistryAttestationRecord[] } | null> {
    const publication = await this.deps.graph.getNode(input.publication_urn);
    if (!publication || (publication.entity_type !== 'SKILL_VERSION' && publication.entity_type !== 'AGENT_VERSION')) {
      return null;
    }
    const edges = await this.deps.graph.listEdgesFrom(publication.urn, 'sg:attestedBy');
    const attestations: RegistryAttestationRecord[] = [];
    for (const edge of edges) {
      const artifactNode = await this.deps.graph.getNode(edge.to_urn);
      if (!artifactNode || artifactNode.entity_type !== 'ARTIFACT') continue;
      const subjectDigests = Array.isArray(artifactNode.properties['subject_digests'])
        ? (artifactNode.properties['subject_digests'] as unknown[]).filter(
            (value): value is string => typeof value === 'string',
          )
        : [];
      attestations.push({
        artifact_urn: artifactNode.urn,
        sha256: stringOrUndefined(artifactNode.properties['sha256']) ?? parseArtifactSha256(artifactNode.urn) ?? '',
        signer: stringOrUndefined(artifactNode.properties['signer']) ?? '',
        key_ref: stringOrUndefined(artifactNode.properties['key_ref']) ?? '',
        algorithm: stringOrUndefined(artifactNode.properties['algorithm']) ?? '',
        predicate_type: stringOrUndefined(artifactNode.properties['predicate_type']) ?? '',
        signature_valid: artifactNode.properties['signature_valid'] === true,
        subject_bound: artifactNode.properties['subject_bound'] === true,
        subject_digests: subjectDigests,
        attached_at: stringOrUndefined(artifactNode.properties['attached_at']) ?? '',
      });
    }
    attestations.sort((left, right) => left.attached_at.localeCompare(right.attached_at));
    return { attestations };
  }

  // -------------------------------------------------------------------------
  // Threat-intel advisories
  // -------------------------------------------------------------------------

  async ingestAdvisory(
    input: import('../ports/registry-service.js').RegistryAdvisoryInput,
  ): Promise<{ advisory: import('../ports/registry-service.js').RegistryAdvisoryRecord }> {
    const mode = input.mode ?? 'report';
    const advisory = input.advisory;
    const existing = await this.findAdvisoryNode(advisory.advisory_id);
    if (existing) {
      throw new RegistryCoreError(
        'ADVISORY_EXISTS',
        `Advisory ${advisory.advisory_id} has already been ingested (${existing.urn}).`,
      );
    }
    const resolvedKey = await this.resolveTrustedPublicKeyMaterial(input.key_ref);
    if (!resolvedKey) {
      throw new RegistryCoreError(
        'ADVISORY_TRUSTED_KEY_NOT_FOUND',
        `Trusted public key not available for ${input.key_ref}.`,
      );
    }
    const canonical = canonicalJsonString(advisory);
    const signatureValid = verifyDetachedSignatureBytes({
      algorithm: input.algorithm,
      public_key_pem: resolvedKey.public_key_pem,
      message: canonical,
      signature: input.signature,
    });
    if (!signatureValid) {
      throw new RegistryCoreError(
        'ADVISORY_SIGNATURE_INVALID',
        'Advisory signature failed cryptographic verification over the canonical advisory document.',
      );
    }

    // Store the advisory document as immutable CAS evidence before applying
    // it, so revocations can reference the exact signed bytes.
    const artifact = await this.deps.cas.put({
      bytes: Buffer.from(canonical, 'utf8'),
      media_type: 'application/json',
      original_path: `generated/advisory/${sanitizePathSegment(advisory.advisory_id)}.json`,
    });
    const advisoryUrnValue = artifactUrn(artifact.sha256);

    const matches = await this.resolveAdvisoryMatches(advisory);
    const resolvedMatches: import('../ports/registry-service.js').RegistryAdvisoryMatch[] = [];
    for (const match of matches) {
      let outcome: import('../ports/registry-service.js').RegistryAdvisoryMatchOutcome = 'reported';
      let status = match.status;
      if (match.status === 'revoked') {
        outcome = 'already_revoked';
      } else if (
        match.status !== 'published' &&
        match.status !== 'certified' &&
        match.status !== 'deprecated'
      ) {
        outcome = 'not_revocable';
      } else if (mode === 'enforce') {
        const revokeReason = `auto-revoked by ${advisory.advisory_id} (${advisory.severity}): ${advisory.summary}`;
        if (match.entity_type === 'SKILL_VERSION') {
          await this.revokeSkillVersion({
            skill_key: match.logical_key,
            version: match.version,
            author: 'threat-intel',
            note: revokeReason,
          });
        } else {
          await this.revokeAgentVersion({
            agent_key: match.logical_key,
            version: match.version,
            author: 'threat-intel',
            note: revokeReason,
          });
        }
        await this.attachAdvisoryToPublication(match.publication_urn, advisoryUrnValue);
        outcome = 'revoked';
        status = 'revoked';
      }
      resolvedMatches.push({ ...match, status, outcome });
    }

    const ingestedAt = nowIso();
    await this.deps.graph.upsertNode({
      urn: advisoryUrnValue,
      entity_type: 'ARTIFACT',
      properties: {
        sha256: artifact.sha256,
        size_bytes: artifact.size_bytes,
        media_type: artifact.media_type,
        original_path: artifact.original_path,
        governance_role: 'advisory',
        advisory_id: advisory.advisory_id,
        advisory_source: advisory.source,
        advisory_severity: advisory.severity,
        advisory_summary: advisory.summary,
        ...(advisory.published_at ? { advisory_published_at: advisory.published_at } : {}),
        advisory_references: advisory.references ?? [],
        signer: input.signer,
        key_ref: input.key_ref,
        algorithm: input.algorithm,
        signature: input.signature,
        signature_valid: true,
        ingest_mode: mode,
        ingested_at: ingestedAt,
        advisory_matches: resolvedMatches,
        match_count: resolvedMatches.length,
      },
    });

    return {
      advisory: this.advisoryRecordFromNode({
        urn: advisoryUrnValue,
        properties: {
          sha256: artifact.sha256,
          advisory_id: advisory.advisory_id,
          advisory_source: advisory.source,
          advisory_severity: advisory.severity,
          advisory_summary: advisory.summary,
          ...(advisory.published_at ? { advisory_published_at: advisory.published_at } : {}),
          advisory_references: advisory.references ?? [],
          signer: input.signer,
          key_ref: input.key_ref,
          algorithm: input.algorithm,
          signature: input.signature,
          signature_valid: true,
          ingest_mode: mode,
          ingested_at: ingestedAt,
          advisory_matches: resolvedMatches,
        },
      }),
    };
  }

  async getAdvisory(input: {
    advisory_id: string;
  }): Promise<{ advisory: import('../ports/registry-service.js').RegistryAdvisoryRecord } | null> {
    const node = await this.findAdvisoryNode(input.advisory_id);
    if (!node) return null;
    return { advisory: this.advisoryRecordFromNode(node) };
  }

  async listAdvisories(input?: {
    limit?: number;
    offset?: number;
  }): Promise<{ advisories: import('../ports/registry-service.js').RegistryAdvisoryRecord[] }> {
    const nodes = await this.deps.graph.listNodesByType('ARTIFACT');
    const advisories = nodes
      .filter((node) => node.properties['governance_role'] === 'advisory')
      .map((node) => this.advisoryRecordFromNode(node))
      .sort((left, right) => right.ingested_at.localeCompare(left.ingested_at));
    const offset = input?.offset && input.offset > 0 ? input.offset : 0;
    const limit = input?.limit && input.limit > 0 ? input.limit : advisories.length;
    return { advisories: advisories.slice(offset, offset + limit) };
  }

  private async findAdvisoryNode(advisoryId: string) {
    const nodes = await this.deps.graph.listNodesByType('ARTIFACT');
    return (
      nodes.find(
        (node) =>
          node.properties['governance_role'] === 'advisory' &&
          node.properties['advisory_id'] === advisoryId,
      ) ?? null
    );
  }

  // Maps an advisory to publications: exact artifact digest matches first,
  // then identifier matches (skill/agent key with an optional version lock).
  private async resolveAdvisoryMatches(
    advisory: import('../ports/registry-service.js').RegistryAdvisoryDocument,
  ): Promise<import('../ports/registry-service.js').RegistryAdvisoryMatch[]> {
    const matches = new Map<string, import('../ports/registry-service.js').RegistryAdvisoryMatch>();
    const digestSet = new Set(
      (advisory.affected.artifact_sha256 ?? []).filter(
        (value) => typeof value === 'string' && value.length > 0,
      ),
    );
    if (digestSet.size > 0) {
      for (const node of await this.deps.graph.listNodesByType('SKILL_VERSION')) {
        const sha = stringOrUndefined(node.properties['artifact_sha256']);
        if (!sha || !digestSet.has(sha)) continue;
        const logicalKey =
          stringOrUndefined(node.properties['skill_key']) ?? extractLogicalKeyFromPublicationUrn(node.urn);
        matches.set(node.urn, {
          publication_urn: node.urn,
          entity_type: 'SKILL_VERSION',
          logical_key: logicalKey,
          version: versionFromProperties(node.properties),
          matched_by: 'artifact_sha256',
          status: lifecycleStatus(node.properties),
          outcome: 'reported',
        });
      }
      for (const node of await this.deps.graph.listNodesByType('AGENT_VERSION')) {
        const sha = stringOrUndefined(node.properties['artifact_sha256']);
        if (!sha || !digestSet.has(sha)) continue;
        const logicalKey =
          stringOrUndefined(node.properties['agent_key']) ?? extractLogicalKeyFromPublicationUrn(node.urn);
        matches.set(node.urn, {
          publication_urn: node.urn,
          entity_type: 'AGENT_VERSION',
          logical_key: logicalKey,
          version: versionFromProperties(node.properties),
          matched_by: 'artifact_sha256',
          status: lifecycleStatus(node.properties),
          outcome: 'reported',
        });
      }
    }
    for (const entry of advisory.affected.skills ?? []) {
      const versions = entry.version
        ? [await this.getSkillVersion({ skill_key: entry.skill_key, version: entry.version })]
        : (await this.listSkillVersions({ skill_key: entry.skill_key })).versions;
      for (const version of versions) {
        if (!version) continue;
        const urn = version.skill_version.urn;
        if (matches.has(urn)) continue;
        matches.set(urn, {
          publication_urn: urn,
          entity_type: 'SKILL_VERSION',
          logical_key: entry.skill_key,
          version: versionFromProperties(version.skill_version.properties),
          matched_by: 'identifier',
          status: lifecycleStatus(version.skill_version.properties),
          outcome: 'reported',
        });
      }
    }
    for (const entry of advisory.affected.agents ?? []) {
      const versions = entry.version
        ? [await this.getAgentVersion({ agent_key: entry.agent_key, version: entry.version })]
        : (await this.listAgentVersions({ agent_key: entry.agent_key })).versions;
      for (const version of versions) {
        if (!version) continue;
        const urn = version.agent_version.urn;
        if (matches.has(urn)) continue;
        matches.set(urn, {
          publication_urn: urn,
          entity_type: 'AGENT_VERSION',
          logical_key: entry.agent_key,
          version: versionFromProperties(version.agent_version.properties),
          matched_by: 'identifier',
          status: lifecycleStatus(version.agent_version.properties),
          outcome: 'reported',
        });
      }
    }
    return [...matches.values()].sort(
      (left, right) =>
        left.entity_type.localeCompare(right.entity_type) ||
        left.logical_key.localeCompare(right.logical_key) ||
        left.version - right.version,
    );
  }

  private async attachAdvisoryToPublication(publicationUrn: string, advisoryUrnValue: string): Promise<void> {
    const node = await this.deps.graph.getNode(publicationUrn);
    if (!node) return;
    await this.deps.graph.upsertNode({
      urn: node.urn,
      entity_type: node.entity_type,
      properties: {
        ...node.properties,
        revocation_advisory_urn: advisoryUrnValue,
      },
    });
  }

  private advisoryRecordFromNode(node: { urn: string; properties: Record<string, unknown> }): import('../ports/registry-service.js').RegistryAdvisoryRecord {
    const severityValue = stringOrUndefined(node.properties['advisory_severity']);
    const severity: 'low' | 'moderate' | 'high' | 'critical' =
      severityValue === 'low' || severityValue === 'moderate' || severityValue === 'high' || severityValue === 'critical'
        ? severityValue
        : 'moderate';
    const references = Array.isArray(node.properties['advisory_references'])
      ? (node.properties['advisory_references'] as unknown[]).filter(
          (value): value is string => typeof value === 'string',
        )
      : [];
    const matches = Array.isArray(node.properties['advisory_matches'])
      ? (node.properties['advisory_matches'] as unknown[])
          .filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === 'object')
          .map((match): import('../ports/registry-service.js').RegistryAdvisoryMatch => {
            const outcomeValue = match['outcome'];
            const outcome: import('../ports/registry-service.js').RegistryAdvisoryMatchOutcome =
              outcomeValue === 'revoked' || outcomeValue === 'already_revoked' || outcomeValue === 'not_revocable'
                ? outcomeValue
                : 'reported';
            return {
              publication_urn: String(match['publication_urn'] ?? ''),
              entity_type: match['entity_type'] === 'AGENT_VERSION' ? 'AGENT_VERSION' : 'SKILL_VERSION',
              logical_key: String(match['logical_key'] ?? ''),
              version: typeof match['version'] === 'number' ? match['version'] : 0,
              matched_by: match['matched_by'] === 'identifier' ? 'identifier' : 'artifact_sha256',
              status: String(match['status'] ?? ''),
              outcome,
            };
          })
      : [];
    const publishedAt = stringOrUndefined(node.properties['advisory_published_at']);
    return {
      advisory_urn: node.urn,
      advisory_sha256: stringOrUndefined(node.properties['sha256']) ?? parseArtifactSha256(node.urn) ?? '',
      advisory_id: stringOrUndefined(node.properties['advisory_id']) ?? '',
      source: stringOrUndefined(node.properties['advisory_source']) ?? '',
      severity,
      summary: stringOrUndefined(node.properties['advisory_summary']) ?? '',
      ...(publishedAt ? { published_at: publishedAt } : {}),
      references,
      signer: stringOrUndefined(node.properties['signer']) ?? '',
      key_ref: stringOrUndefined(node.properties['key_ref']) ?? '',
      algorithm: stringOrUndefined(node.properties['algorithm']) ?? '',
      signature: stringOrUndefined(node.properties['signature']) ?? '',
      signature_valid: node.properties['signature_valid'] === true,
      mode: node.properties['ingest_mode'] === 'enforce' ? 'enforce' : 'report',
      ingested_at: stringOrUndefined(node.properties['ingested_at']) ?? '',
      matches,
    };
  }

  private async loadSignatureDocument(artifactUrnValue: string): Promise<Record<string, unknown> | null> {
    const sha256 = parseArtifactSha256(artifactUrnValue);
    if (!sha256) return null;
    const stored = await this.readCasArtifact(sha256);
    if (!stored || !stored.digest_verified) return null;
    try {
      const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: false }).decode(stored.bytes)) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  private async readCasArtifact(
    sha256: string,
  ): Promise<Awaited<ReturnType<ArtifactStore['getBySha256']>>> {
    try {
      return await this.deps.cas.getBySha256(sha256);
    } catch (err) {
      if (err instanceof CasIntegrityError) {
        throw new RegistryCoreError(
          'ARTIFACT_DIGEST_MISMATCH',
          `Artifact ${err.requested_sha256} failed its integrity check (computed ${err.computed_sha256}).`,
        );
      }
      throw err;
    }
  }

  // The CAS record carries media_type only for backends that persist it (S3
  // object content type). The ARTIFACT node is the durable record, so fall
  // back to it for filesystem-backed stores.
  private async resolveArtifactMediaType(sha256: string, casMediaType?: string): Promise<string | undefined> {
    if (casMediaType) return casMediaType;
    const node = await this.deps.graph.getNode(artifactUrn(sha256));
    return stringOrUndefined(node?.properties['media_type']);
  }

  private async resolveAndValidateSkillRefs(
    skillRefs: RegistrySkillRefInput[] | undefined,
  ): Promise<Array<{ skill_urn: string; skill_key?: string }> | undefined> {
    if (!skillRefs) return undefined;
    const normalized: Array<{ skill_urn: string; skill_key?: string }> = [];
    for (const ref of skillRefs) {
      const resolvedUrn = resolveSkillUrn(ref.skill_urn, ref.skill_key);
      const existingSkill = await this.deps.graph.getNode(resolvedUrn);
      if (!existingSkill || existingSkill.entity_type !== 'SKILL') {
        throw new RegistryCoreError('SKILL_NOT_FOUND', `Skill not found: ${ref.skill_key ?? ref.skill_urn}`);
      }

      const normalizedSkillKey = ref.skill_key ?? parseSkillKey(resolvedUrn);
      normalized.push({
        skill_urn: resolvedUrn,
        ...(toOptionalStringProp('skill_key', normalizedSkillKey)),
      });
    }
    return normalized;
  }

  private async matchesCreateAgentInput(existing: RegistryAgentDetails, input: CreateAgentInput): Promise<boolean> {
    const properties = existing.agent.properties;
    const existingSkillUrns = [...existing.skills.map((s) => s.skill_urn)].sort();
    const requestedSkillUrns = [
      ...((await this.resolveAndValidateSkillRefs(input.skill_refs)) ?? []).map((s) => s.skill_urn),
    ].sort();
    const existingArtifactSha = existing.artifacts[0]?.sha256;
    const requestedArtifactSha = input.artifact
      ? sha256Hex(decodeArtifactInput(input.artifact.content, input.artifact.encoding))
      : undefined;

    return (
      String(properties['agent_key'] ?? '') === input.agent_key &&
      stringOrUndefined(properties['harness_name']) === input.harness_name &&
      stringOrUndefined(properties['display_name']) === input.display_name &&
      stringOrUndefined(properties['description']) === input.description &&
      stringOrUndefined(properties['source_path']) === resolveAgentSourcePath(input) &&
      JSON.stringify(existingSkillUrns) === JSON.stringify(requestedSkillUrns) &&
      existingArtifactSha === requestedArtifactSha
    );
  }

  private async matchesCreateSkillInput(existing: RegistrySkillDetails, input: CreateSkillInput): Promise<boolean> {
    const properties = existing.skill.properties;
    const existingArtifactSha = existing.artifacts[0]?.sha256;
    const requestedArtifactSha = input.artifact
      ? sha256Hex(decodeArtifactInput(input.artifact.content, input.artifact.encoding))
      : undefined;

    return (
      String(properties['skill_key'] ?? '') === input.skill_key &&
      stringOrUndefined(properties['display_name']) === input.display_name &&
      stringOrUndefined(properties['description']) === input.description &&
      stringOrUndefined(properties['source_path']) === resolveSkillSourcePath(input) &&
      existingArtifactSha === requestedArtifactSha
    );
  }

  private async ensureLogicalSkill(input: {
    skill_key: string;
    display_name?: string;
    description?: string;
    source_path?: string;
  }) {
    const skillNodeUrn = skillUrn(input.skill_key);
    const existing = await this.deps.graph.getNode(skillNodeUrn);
    if (existing) return existing;

    await this.deps.graph.upsertNode({
      urn: skillNodeUrn,
      entity_type: 'SKILL',
      properties: {
        skill_key: input.skill_key,
        ...(input.display_name ? { display_name: input.display_name } : {}),
        ...(input.description ? { description: input.description } : {}),
        ...(input.source_path ? { source_path: input.source_path } : {}),
      },
    });

    const created = await this.deps.graph.getNode(skillNodeUrn);
    if (!created) {
      throw new RegistryCoreError('SKILL_CREATE_FAILED', 'Failed to create logical skill.');
    }
    return created;
  }

  private async getSkillVersionByUrn(skillVersionUrnValue: string): Promise<RegistrySkillVersionDetails | null> {
    const node = await this.deps.graph.getNode(skillVersionUrnValue);
    if (!node || node.entity_type !== 'SKILL_VERSION') return null;
    const artifactEdges = await this.deps.graph.listEdgesFrom(node.urn, 'sg:implementedBy');
    const upstreamVersionEdges = await this.deps.graph.listEdgesFrom(node.urn, 'sg:dependsOnVersion');
    return {
      skill_version: { urn: node.urn, properties: node.properties },
      artifacts: artifactEdges.map((e) => ({
        artifact_urn: e.to_urn,
        ...(toOptionalStringProp('sha256', parseArtifactSha256(e.to_urn))),
      })),
      upstream_versions: upstreamVersionEdges.map((e) => ({
        skill_version_urn: e.to_urn,
      })),
      governance_artifacts: await this.loadGovernanceArtifacts(node.urn),
    };
  }

  private async getAgentVersionByUrn(agentVersionUrnValue: string): Promise<RegistryAgentVersionDetails | null> {
    const node = await this.deps.graph.getNode(agentVersionUrnValue);
    if (!node || node.entity_type !== 'AGENT_VERSION') return null;
    const skillsEdges = await this.deps.graph.listEdgesFrom(node.urn, 'sg:usesSkill');
    const artifactEdges = await this.deps.graph.listEdgesFrom(node.urn, 'sg:definedBy');
    const harnessEdges = await this.deps.graph.listEdgesFrom(node.urn, 'sg:runsOn');
    return {
      agent_version: { urn: node.urn, properties: node.properties },
      skills: skillsEdges.map((e) => ({
        skill_urn: e.to_urn,
        ...(toOptionalStringProp('skill_key', parseSkillKey(e.to_urn))),
      })),
      artifacts: artifactEdges.map((e) => ({
        artifact_urn: e.to_urn,
        ...(toOptionalStringProp('sha256', parseArtifactSha256(e.to_urn))),
      })),
      harnesses: harnessEdges.map((e) => ({
        harness_urn: e.to_urn,
        ...(toOptionalStringProp('harness_name', parseHarnessName(e.to_urn))),
      })),
      governance_artifacts: await this.loadGovernanceArtifacts(node.urn),
    };
  }

  private async getRequiredSkillVersion(skillKey: string, version: number): Promise<RegistrySkillVersionDetails> {
    const got = await this.getSkillVersion({ skill_key: skillKey, version });
    if (!got) {
      throw new RegistryCoreError('SKILL_VERSION_NOT_FOUND', `Skill version not found: ${skillKey}@v${version}`);
    }
    return got;
  }

  private async transitionSkillVersion(input: SkillVersionOperationInput & {
    operation: RegistryOperationKind;
    allowCurrentStatuses: RegistryLifecycleStatus[];
    nextStatus: RegistryLifecycleStatus;
    allowedFrom?: RegistryLifecycleStatus[];
    activateIfMissing?: boolean;
    clearActiveIfTarget?: boolean;
    provUsedUrns?: string[];
  }): Promise<RegistryOperationResult<RegistrySkillVersionDetails>> {
    const version = await this.getRequiredSkillVersion(input.skill_key, input.version);
    const currentStatus = lifecycleStatus(version.skill_version.properties);

    if (input.allowCurrentStatuses.includes(currentStatus)) {
      const task = await this.createTask({
        operation: input.operation,
        author: input.author,
        target_urn: version.skill_version.urn,
        skill_key: input.skill_key,
        version: input.version,
        status: 'noop',
        ...(input.note ? { note: input.note } : {}),
      });
      return { task, result: version };
    }

    if (input.allowedFrom && !input.allowedFrom.includes(currentStatus)) {
      throw new RegistryCoreError(
        `SKILL_VERSION_${input.operation.toUpperCase()}_CONFLICT`,
        `Skill version cannot ${input.operation} from status ${currentStatus}.`,
      );
    }

    if (input.operation === 'publish') {
      await this.enforceHumanReviewGate({
        properties: version.skill_version.properties,
        errorCode: 'SKILL_VERSION_PUBLISH_CONFLICT',
        action: 'publish',
      });
      await this.enforcePublicationTrustGates({
        publication_urn: version.skill_version.urn,
        properties: version.skill_version.properties,
        operation: 'publish',
        errorCodePrefix: 'SKILL_VERSION',
      });
    }
    let publishUsedUrns: string[] = [];
    let preparedRecord: PreparedPublicationRecord | null = null;
    if (input.operation === 'publish' && input.prepared_publication_urn) {
      preparedRecord = await this.loadPreparedPublicationRecord({
        prepared_publication_urn: input.prepared_publication_urn,
        expected_publication_urn: version.skill_version.urn,
        errorPrefix: 'SKILL_VERSION',
      });
      await this.verifyPreparedPublicationRecord({
        record: preparedRecord,
        entity_type: 'SKILL_VERSION',
        logical_key: input.skill_key,
        logical_urn: skillUrn(input.skill_key),
        publication_urn: version.skill_version.urn,
        version_properties: version.skill_version.properties,
        artifacts: version.artifacts,
        author: input.author,
        ...(input.note ? { note: input.note } : {}),
        ...(input.governance ? { governance: input.governance } : {}),
        activate_if_missing: true,
        errorPrefix: 'SKILL_VERSION',
      });
      if (input.signatures && input.signatures.length > 0) {
        await this.validatePreparedPublicationSignatures({
          logical_key: input.skill_key,
          candidate: preparedRecord.candidate,
          signatures: input.signatures,
          errorPrefix: 'SKILL_VERSION',
        });
      }
    }
    if (input.operation === 'publish' && !preparedRecord && input.signatures && input.signatures.length > 0) {
      throw new RegistryCoreError(
        'SKILL_VERSION_SIGNATURES_REQUIRE_PREPARED',
        'Detached signatures at publish require a prepared publication.',
      );
    }
    const publication =
      input.operation === 'publish'
        ? preparedRecord
          ? {
              properties: preparedRecord.candidate.properties,
              taskEvidence: taskEvidenceFromPublicationProperties(preparedRecord.candidate.properties),
            }
          : ensureSkillGovernanceReady({
              version,
              actor: input.author,
              ...(input.governance ? { governance: input.governance } : {}),
              ...(input.note ? { note: input.note } : {}),
            })
        : undefined;
    const previousActive =
      input.operation === 'promote'
        ? await this.getActiveSkillVersion({ skill_key: input.skill_key })
        : null;

    const updatedProps = preparedRecord
      ? { ...preparedRecord.candidate.properties }
      : {
          ...version.skill_version.properties,
          ...(publication?.properties ?? {}),
          lifecycle_status: input.nextStatus,
          updated_at: nowIso(),
        };
    await this.deps.graph.upsertNode({
      urn: version.skill_version.urn,
      entity_type: 'SKILL_VERSION',
      properties: updatedProps,
    });

    if (input.activateIfMissing) {
      const active = await this.getActiveSkillVersion({ skill_key: input.skill_key });
      if (!active) {
        await this.setActiveVersion(input.skill_key, version.skill_version.urn);
      }
    }

    if (input.operation === 'publish' && publication) {
      const governanceArtifacts = preparedRecord
        ? await this.materializePreparedGovernanceArtifacts({
            entity_type: 'SKILL_VERSION',
            logical_key: input.skill_key,
            publication_urn: version.skill_version.urn,
            candidate: preparedRecord.candidate,
            properties: preparedRecord.candidate.properties,
            pinned_artifact_append_intents: preparedRecord.pinned.artifact_append_intents,
            errorPrefix: 'SKILL_VERSION',
          })
        : await this.buildGovernanceArtifactsForPublication({
            entity_type: 'SKILL_VERSION',
            logical_key: input.skill_key,
            publication_urn: version.skill_version.urn,
            actor: publication.properties['publisher'] as string,
            policy_version: publication.properties['policy_version'] as string,
            validation_report: publication.properties['validation_report'] as string,
          });
      await this.attachGovernanceArtifacts(version.skill_version.urn, governanceArtifacts);
      publishUsedUrns = governanceArtifacts.map((artifact) => artifact.artifact_urn);
      if (!preparedRecord?.pinned.append_intent) {
        await this.recordPublicationAppendIntent({
          publication_urn: version.skill_version.urn,
          logical_key: input.skill_key,
          entity_type: 'SKILL_VERSION',
          note: 'skill publication',
        });
      }
      // Canonical RDF (RDFC-1.0) projection of the published graph for
      // semantic signatures, stored as a CAS artifact with its digest
      // recorded on the version.
      // Project from the current node state (post-activation), not the
      // stale pre-publish property set, so the recorded semantic digest
      // matches later re-projection at verification time.
      const projectionNode = await this.deps.graph.getNode(version.skill_version.urn);
      const canonicalRdf = await this.publishCanonicalRdfArtifact({
        publication_urn: version.skill_version.urn,
        logical_urn: skillUrn(input.skill_key),
        properties: projectionNode?.properties ?? updatedProps,
      });
      const nodeWithRdf = await this.deps.graph.getNode(version.skill_version.urn);
      if (nodeWithRdf) {
        await this.deps.graph.upsertNode({
          urn: nodeWithRdf.urn,
          entity_type: nodeWithRdf.entity_type,
          properties: {
            ...nodeWithRdf.properties,
            canonical_rdf_sha256: canonicalRdf.sha256,
            canonical_rdf_artifact_urn: canonicalRdf.artifact_urn,
          },
        });
      }
      // Freeze the publication envelope bytes as a CAS artifact. The frozen
      // payload is what the publication envelope endpoint serves from here
      // on, so later evidence attachment cannot invalidate signatures.
      const frozenEnvelope = await this.freezePublicationEnvelope({
        publication_urn: version.skill_version.urn,
        entity_type: 'SKILL_VERSION',
        logical_key: input.skill_key,
      });
      if (frozenEnvelope) publishUsedUrns.push(frozenEnvelope.artifact_urn);
      if (
        preparedRecord &&
        frozenEnvelope &&
        frozenEnvelope.sha256 !== preparedRecord.candidate.canonical_json_sha256
      ) {
        throw new RegistryCoreError(
          'SKILL_VERSION_PUBLISH_PREPARED_STALE',
          'Frozen envelope diverged from the prepared candidate.',
        );
      }
      if (preparedRecord && input.signatures && input.signatures.length > 0) {
        const signatureUrns = await this.attachPublicationSignatures({
          publication_urn: version.skill_version.urn,
          logical_key: input.skill_key,
          candidate: preparedRecord.candidate,
          candidate_properties: preparedRecord.candidate.properties,
          signatures: input.signatures,
          errorPrefix: 'SKILL_VERSION',
        });
        publishUsedUrns.push(...signatureUrns);
      }
    }

    if (input.clearActiveIfTarget) {
      const active = await this.getActiveSkillVersion({ skill_key: input.skill_key });
      if (active?.skill_version.urn === version.skill_version.urn) {
        await this.clearActiveVersion(input.skill_key);
      }
    }

    if (input.operation === 'promote' && previousActive && previousActive.skill_version.urn !== version.skill_version.urn) {
      await this.deps.graph.upsertNode({
        urn: previousActive.skill_version.urn,
        entity_type: 'SKILL_VERSION',
        properties: {
          ...previousActive.skill_version.properties,
          publication_status: 'superseded',
          superseded_by_version_urn: version.skill_version.urn,
          superseded_at: nowIso(),
          active: false,
        },
      });
      await this.deps.graph.upsertEdge({
        from_urn: version.skill_version.urn,
        to_urn: previousActive.skill_version.urn,
        predicate: 'sg:supersedesVersion',
        properties: {},
      });
    }

    const result = await this.getRequiredSkillVersion(input.skill_key, input.version);
    const task = await this.createTask({
      operation: input.operation,
      author: input.author,
      target_urn: version.skill_version.urn,
      skill_key: input.skill_key,
      version: input.version,
      status: 'completed',
      prov_used_urns: [...(input.provUsedUrns ?? []), ...publishUsedUrns],
      ...(input.note ? { note: input.note } : {}),
      ...(publication?.taskEvidence ?? {}),
    });
    return { task, result };
  }

  private async setActiveVersion(skillKey: string, versionUrn: string): Promise<void> {
    const logicalSkill = await this.ensureLogicalSkill({ skill_key: skillKey });
    await this.deps.graph.upsertNode({
      urn: logicalSkill.urn,
      entity_type: 'SKILL',
      properties: {
        ...logicalSkill.properties,
        active_version_urn: versionUrn,
      },
    });

    const versions = await this.listSkillVersions({ skill_key: skillKey });
    for (const version of versions.versions) {
      await this.deps.graph.upsertNode({
        urn: version.skill_version.urn,
        entity_type: 'SKILL_VERSION',
        properties: {
          ...version.skill_version.properties,
          active: version.skill_version.urn === versionUrn,
        },
      });
    }
  }

  private async clearActiveVersion(skillKey: string): Promise<void> {
    const logicalSkill = await this.ensureLogicalSkill({ skill_key: skillKey });
    const props = { ...logicalSkill.properties };
    delete props['active_version_urn'];
    await this.deps.graph.upsertNode({
      urn: logicalSkill.urn,
      entity_type: 'SKILL',
      properties: props,
    });

    const versions = await this.listSkillVersions({ skill_key: skillKey });
    for (const version of versions.versions) {
      await this.deps.graph.upsertNode({
        urn: version.skill_version.urn,
        entity_type: 'SKILL_VERSION',
        properties: {
          ...version.skill_version.properties,
          active: false,
        },
      });
    }
  }

  private async findMatchingDraft(
    skillKey: string,
    input: { sha256: string; commit_sha?: string; git_tag?: string; source_path?: string },
  ): Promise<RegistrySkillVersionDetails | null> {
    const versions = await this.listSkillVersions({ skill_key: skillKey });
    return (
      versions.versions.find((version) => {
        const props = version.skill_version.properties;
        return (
          lifecycleStatus(props) === 'draft' &&
          stringOrUndefined(props['artifact_sha256']) === input.sha256 &&
          stringOrUndefined(props['commit_sha']) === input.commit_sha &&
          stringOrUndefined(props['git_tag']) === input.git_tag &&
          stringOrUndefined(props['source_path']) === input.source_path
        );
      }) ?? null
    );
  }

  private async createTask(input: {
    operation: RegistryOperationKind;
    author: string;
    target_urn: string;
    skill_key?: string;
    agent_key?: string;
    version: number;
    status: 'completed' | 'noop';
    commit_sha?: string;
    git_tag?: string;
    artifact_signature?: string;
    artifact_sha256?: string;
    note?: string;
    publisher?: string;
    policy_version?: string;
    validation_status?: string;
    validation_report?: string;
    validation_failures?: string;
    canonical_json_sha256?: string;
    signature_ref?: string;
    approved_by?: string;
    approved_role?: string;
    prov_used_urns?: string[];
    prov_associated_agents?: Array<{ agent: string; role: string }>;
  }): Promise<RegistryTaskDetails> {
    const task_id = randomUUID();
    const urn = taskUrn(task_id);
    const occurredAt = nowIso();
    await this.deps.graph.upsertNode({
      urn,
      entity_type: 'TASK',
      properties: {
        task_id,
        operation: input.operation,
        status: input.status,
        author: input.author,
        occurred_at: occurredAt,
        ...(input.skill_key ? { skill_key: input.skill_key } : {}),
        ...(input.agent_key ? { agent_key: input.agent_key } : {}),
        version: input.version,
        ...(input.commit_sha ? { commit_sha: input.commit_sha } : {}),
        ...(input.git_tag ? { git_tag: input.git_tag } : {}),
        ...(input.artifact_signature ? { artifact_signature: input.artifact_signature } : {}),
        ...(input.artifact_sha256 ? { artifact_sha256: input.artifact_sha256 } : {}),
        ...(input.note ? { note: input.note } : {}),
        ...(input.publisher ? { publisher: input.publisher } : {}),
        ...(input.policy_version ? { policy_version: input.policy_version } : {}),
        ...(input.validation_status ? { validation_status: input.validation_status } : {}),
        ...(input.validation_report ? { validation_report: input.validation_report } : {}),
        ...(input.validation_failures ? { validation_failures: input.validation_failures } : {}),
        ...(input.canonical_json_sha256 ? { canonical_json_sha256: input.canonical_json_sha256 } : {}),
        ...(input.signature_ref ? { signature_ref: input.signature_ref } : {}),
        ...(input.approved_by ? { approved_by: input.approved_by } : {}),
        ...(input.approved_role ? { approved_role: input.approved_role } : {}),
      },
    });
    await this.deps.graph.upsertEdge({
      from_urn: urn,
      to_urn: input.target_urn,
      predicate: 'sg:targets',
      properties: {},
    });

    // PROV-O structure: the TASK is the prov:Activity, the target version
    // is a prov:Entity it generated, actors are prov:Agent records, and
    // policy/ontology packages and reports are prov:used entities.
    await this.deps.graph.upsertEdge({
      from_urn: input.target_urn,
      to_urn: urn,
      predicate: 'prov:wasGeneratedBy',
      properties: {},
    });
    const associatedAgents = [
      { agent: input.author, role: 'author' },
      ...(input.prov_associated_agents ?? []),
    ];
    for (const associated of associatedAgents) {
      const agentNodeUrn = provAgentUrn(associated.agent);
      await this.deps.graph.upsertNode({
        urn: agentNodeUrn,
        entity_type: 'PROV_AGENT',
        properties: { agent_name: associated.agent },
      });
      await this.deps.graph.upsertEdge({
        from_urn: urn,
        to_urn: agentNodeUrn,
        predicate: 'prov:wasAssociatedWith',
        properties: { role: associated.role },
      });
    }
    for (const usedUrn of input.prov_used_urns ?? []) {
      await this.deps.graph.upsertEdge({
        from_urn: urn,
        to_urn: usedUrn,
        predicate: 'prov:used',
        properties: {},
      });
    }

    // Transparency logging: every completed lifecycle operation emits a
    // canonical governance event, stored as an immutable CAS artifact and
    // appended to the internal append-only Merkle log. Noop (idempotent
    // replay) tasks do not emit events.
    if (input.status === 'completed') {
      await this.appendGovernanceEvent({
        operation: input.operation,
        author: input.author,
        occurred_at: occurredAt,
        task_urn: urn,
        target_urn: input.target_urn,
        ...(input.skill_key ? { skill_key: input.skill_key } : {}),
        ...(input.agent_key ? { agent_key: input.agent_key } : {}),
        ...(input.policy_version ? { policy_version: input.policy_version } : {}),
        ...(input.canonical_json_sha256 ? { envelope_sha256: input.canonical_json_sha256 } : {}),
      });
    }

    return {
      task: {
        urn,
        properties: {
          task_id,
          operation: input.operation,
          status: input.status,
          author: input.author,
          occurred_at: occurredAt,
          ...(input.skill_key ? { skill_key: input.skill_key } : {}),
          ...(input.agent_key ? { agent_key: input.agent_key } : {}),
          version: input.version,
          ...(input.commit_sha ? { commit_sha: input.commit_sha } : {}),
          ...(input.git_tag ? { git_tag: input.git_tag } : {}),
          ...(input.artifact_signature ? { artifact_signature: input.artifact_signature } : {}),
          ...(input.artifact_sha256 ? { artifact_sha256: input.artifact_sha256 } : {}),
          ...(input.note ? { note: input.note } : {}),
          ...(input.publisher ? { publisher: input.publisher } : {}),
          ...(input.policy_version ? { policy_version: input.policy_version } : {}),
          ...(input.validation_status ? { validation_status: input.validation_status } : {}),
          ...(input.validation_report ? { validation_report: input.validation_report } : {}),
          ...(input.validation_failures ? { validation_failures: input.validation_failures } : {}),
          ...(input.canonical_json_sha256 ? { canonical_json_sha256: input.canonical_json_sha256 } : {}),
          ...(input.signature_ref ? { signature_ref: input.signature_ref } : {}),
          ...(input.approved_by ? { approved_by: input.approved_by } : {}),
          ...(input.approved_role ? { approved_role: input.approved_role } : {}),
        },
      },
      targets: [{ target_urn: input.target_urn }],
    };
  }

  private async appendGovernanceEvent(input: {
    operation: string;
    author: string;
    occurred_at: string;
    task_urn: string;
    target_urn: string;
    skill_key?: string;
    agent_key?: string;
    policy_version?: string;
    envelope_sha256?: string;
  }) {
    const targetNode = await this.deps.graph.getNode(input.target_urn);
    if (!targetNode || (targetNode.entity_type !== 'SKILL_VERSION' && targetNode.entity_type !== 'AGENT_VERSION')) {
      return;
    }
    const logicalUrn = input.skill_key
      ? skillUrn(input.skill_key)
      : input.agent_key
        ? agentUrn(input.agent_key)
        : undefined;
    if (!logicalUrn) return;
    const policyVersion = input.policy_version ?? stringOrUndefined(targetNode.properties['policy_version']);
    const ontologyVersion = stringOrUndefined(targetNode.properties['ontology_version']);
    const envelopeSha = input.envelope_sha256 ?? stringOrUndefined(targetNode.properties['canonical_json_sha256']);

    // Canonical (RFC 8785 JCS) governance event JSON + SHA-256 digest.
    const canonical = canonicalJsonString({
      event_type: input.operation,
      publication_urn: input.target_urn,
      logical_urn: logicalUrn,
      entity_type: targetNode.entity_type,
      actor: input.author,
      occurred_at: input.occurred_at,
      task_urn: input.task_urn,
      ...(policyVersion ? { policy_version: policyVersion } : {}),
      ...(ontologyVersion ? { ontology_version: ontologyVersion } : {}),
      ...(envelopeSha ? { envelope_sha256: envelopeSha } : {}),
    });
    const eventSha = sha256Hex(Buffer.from(canonical, 'utf8'));

    // WORM-friendly evidence retention: the event document lives in the
    // content-addressed store, immutable by construction.
    const artifact = await this.deps.cas.put({
      bytes: Buffer.from(canonical, 'utf8'),
      media_type: 'application/json',
      original_path: `generated/governance-event/${sanitizePathSegment(input.target_urn)}.json`,
    });
    const eventArtifactUrn = artifactUrn(artifact.sha256);
    await this.deps.graph.upsertNode({
      urn: eventArtifactUrn,
      entity_type: 'ARTIFACT',
      properties: {
        sha256: artifact.sha256,
        size_bytes: artifact.size_bytes,
        media_type: artifact.media_type,
        original_path: artifact.original_path,
        governance_role: 'governance_event',
        event_type: input.operation,
        publication_urn: input.target_urn,
        task_urn: input.task_urn,
      },
    });

    // Append the event to the internal append-only Merkle log.
    const existing = await this.deps.graph.getNode(GOVERNANCE_LOG_URN);
    const leafHashes = [
      ...(Array.isArray(existing?.properties['leaf_hashes']) ? (existing.properties['leaf_hashes'] as string[]) : []),
    ];
    const eventUrns = [
      ...(Array.isArray(existing?.properties['event_artifact_urns'])
        ? (existing.properties['event_artifact_urns'] as string[])
        : []),
    ];
    leafHashes.push(rfc6962LeafHash(canonical).toString('hex'));
    eventUrns.push(eventArtifactUrn);
    const treeSize = leafHashes.length;
    const rootHash = computeMerkleRoot(leafHashes);
    await this.deps.graph.upsertNode({
      urn: GOVERNANCE_LOG_URN,
      entity_type: 'GOVERNANCE_LOG',
      properties: {
        log_id: 'registry-governance',
        log_type: 'internal-merkle',
        tree_size: treeSize,
        root_hash: rootHash,
        leaf_hashes: leafHashes,
        event_artifact_urns: eventUrns,
        updated_at: nowIso(),
      },
    });

    // Record the log position on the TASK for forensic inspection.
    const taskNode = await this.deps.graph.getNode(input.task_urn);
    if (taskNode) {
      await this.deps.graph.upsertNode({
        urn: taskNode.urn,
        entity_type: 'TASK',
        properties: {
          ...taskNode.properties,
          governance_event_artifact_urn: eventArtifactUrn,
          governance_event_sha256: eventSha,
          log_leaf_index: treeSize - 1,
          log_tree_size: treeSize,
          log_root_hash: rootHash,
        },
      });
    }

    // Stage the event digest through the Tessera sidecar when configured,
    // anchoring the internal log to the external transparency backend.
    if (this.deps.appendIntentPublisher) {
      try {
        await this.deps.appendIntentPublisher.publishAppendIntent({
          source_urn: input.target_urn,
          source_type: 'governance_event',
          digest: eventSha,
          digest_algorithm: 'sha256',
          content_type: 'application/json',
          note: `governance event: ${input.operation}`,
          payload: {
            event_type: input.operation,
            publication_urn: input.target_urn,
            task_urn: input.task_urn,
            event_artifact_urn: eventArtifactUrn,
            log_leaf_index: treeSize - 1,
            log_tree_size: treeSize,
            log_root_hash: rootHash,
          },
        });
      } catch {
        // Sidecar staging is best-effort; the internal log remains the
        // registry's own append-only record of governance events.
      }
    }
  }

  // Reconciles the registry-recorded transparency append intents for a
  // publication against the native companion log: re-fetches each log entry,
  // re-derives the record digest and leaf hash, validates the RFC 6962
  // inclusion proof against the signed checkpoint, and stores the outcome as
  // CAS evidence linked from the publication version.
  async reconcilePublicationTransparency(input: {
    publication_urn: string;
  }): Promise<import('../ports/registry-service.js').RegistryTransparencyReconciliation> {
    const reconciler = this.deps.transparencyReconciler;
    if (!reconciler) {
      throw new RegistryCoreError(
        'TRANSPARENCY_RECONCILIATION_NOT_CONFIGURED',
        'Transparency reconciliation requires TESSERA_SIDECAR_URL, TRANSPARENCY_APPEND_LOG_ID, and TESSERA_LOG_PUBLIC_KEY.',
      );
    }
    const isSkill = input.publication_urn.startsWith('urn:sg:skill-version:');
    const isAgent = input.publication_urn.startsWith('urn:sg:agent-version:');
    if (!isSkill && !isAgent) {
      throw new RegistryCoreError(
        'TRANSPARENCY_RECONCILIATION_INVALID',
        `Unsupported publication URN: ${input.publication_urn}`,
      );
    }
    const logicalKey = extractLogicalKeyFromPublicationUrn(input.publication_urn);
    const versionNumber = extractVersionFromPublicationUrn(input.publication_urn);
    const details = isSkill
      ? await this.getSkillVersion({ skill_key: logicalKey, version: versionNumber })
      : await this.getAgentVersion({ agent_key: logicalKey, version: versionNumber });
    if (!details) {
      throw new RegistryCoreError('PUBLICATION_NOT_FOUND', `Publication not found: ${input.publication_urn}`);
    }
    const versionNode = 'skill_version' in details ? details.skill_version : details.agent_version;

    const intents: Array<import('../ports/registry-service.js').RegistryTransparencyAppendIntentRef> = [];
    const publicationIntent = readTransparencyAppendIntentFromProperties(versionNode.properties);
    if (publicationIntent) intents.push(publicationIntent);
    for (const artifact of details.governance_artifacts) {
      if (artifact.transparency_append_intent) intents.push(artifact.transparency_append_intent);
    }
    // Evidence artifacts outside the envelope refs: provenance signatures
    // (plus the export each signature binds, found via provenance_sha256) and
    // validation-report RDF artifacts.
    const provenanceSignatureEdges = await this.deps.graph.listEdgesFrom(
      input.publication_urn,
      'sg:hasProvenanceSignature',
    );
    for (const edge of provenanceSignatureEdges) {
      const node = await this.deps.graph.getNode(edge.to_urn);
      if (!node) continue;
      const signatureIntent = readTransparencyAppendIntentFromProperties(node.properties);
      if (signatureIntent) intents.push(signatureIntent);
      const provenanceSha = stringOrUndefined(node.properties['provenance_sha256']);
      if (provenanceSha && /^[0-9a-f]{64}$/.test(provenanceSha)) {
        const exportNode = await this.deps.graph.getNode(artifactUrn(provenanceSha));
        const exportIntent = exportNode ? readTransparencyAppendIntentFromProperties(exportNode.properties) : null;
        if (exportIntent) intents.push(exportIntent);
      }
    }
    const reportRdfEdges = await this.deps.graph.listEdgesFrom(input.publication_urn, 'sg:hasValidationReportRdf');
    for (const edge of reportRdfEdges) {
      const node = await this.deps.graph.getNode(edge.to_urn);
      const intent = node ? readTransparencyAppendIntentFromProperties(node.properties) : null;
      if (intent) intents.push(intent);
    }
    const reportSignatureEdges = await this.deps.graph.listEdgesFrom(input.publication_urn, 'sg:hasReportSignature');
    for (const edge of reportSignatureEdges) {
      const node = await this.deps.graph.getNode(edge.to_urn);
      const intent = node ? readTransparencyAppendIntentFromProperties(node.properties) : null;
      if (intent) intents.push(intent);
    }
    const uniqueIntents = [...new Map(intents.map((intent) => [intent.request_id, intent])).values()];

    const reconciledAt = nowIso();
    const keyHint = keyHintForPublicKeyPem(reconciler.public_key_pem);
    const outcomes: import('../ports/registry-service.js').RegistryTransparencyReconciliationOutcome[] = [];
    for (const intent of uniqueIntents) {
      const base = {
        source_type: intent.source_type,
        request_id: intent.request_id,
        request_record_sha256: intent.request_record_sha256,
        s3_uri: intent.s3_uri,
        ...(typeof intent.tessera_entry_index === 'number'
          ? { tessera_entry_index: intent.tessera_entry_index }
          : {}),
        ...(intent.tessera_submission_status
          ? { tessera_submission_status: intent.tessera_submission_status }
          : {}),
      };
      if (typeof intent.tessera_entry_index !== 'number') {
        outcomes.push({
          ...base,
          status: 'not_submitted',
          checks: [],
          ...(intent.tessera_submission_error ? { error: intent.tessera_submission_error } : {}),
        });
        continue;
      }
      let entry: Record<string, unknown>;
      try {
        entry = await reconciler.fetchLogEntry({
          log_id: intent.log_id,
          entry_index: intent.tessera_entry_index,
        });
      } catch (err) {
        outcomes.push({
          ...base,
          status: 'fetch_failed',
          checks: [],
          error: err instanceof Error ? err.message : 'transparency log entry fetch failed',
        });
        continue;
      }
      const checks = checkReconciledLogEntry({
        entry,
        intent,
        publicKeyPem: reconciler.public_key_pem,
        keyHint,
      });
      outcomes.push({
        ...base,
        status: checks.every((check) => check.ok) ? 'verified' : 'mismatch',
        checks,
      });
    }

    const status: import('../ports/registry-service.js').RegistryTransparencyReconciliation['status'] =
      outcomes.some((outcome) => outcome.status === 'mismatch')
        ? 'mismatch'
        : outcomes.length > 0 && outcomes.every((outcome) => outcome.status === 'verified')
          ? 'verified'
          : 'incomplete';

    const evidenceContent = canonicalJsonString({
      publication_urn: input.publication_urn,
      log_id: intents[0]?.log_id ?? null,
      reconciled_at: reconciledAt,
      status,
      outcomes,
    });
    const evidence = await this.deps.cas.put({
      bytes: Buffer.from(evidenceContent, 'utf8'),
      media_type: 'application/json',
      original_path: `generated/transparency_reconciliation/${sanitizePathSegment(logicalKey)}.json`,
    });
    const artifactNodeUrn = artifactUrn(evidence.sha256);
    await this.deps.graph.upsertNode({
      urn: artifactNodeUrn,
      entity_type: 'ARTIFACT',
      properties: {
        sha256: evidence.sha256,
        size_bytes: evidence.size_bytes,
        media_type: evidence.media_type,
        original_path: evidence.original_path,
        governance_role: 'transparency_reconciliation',
      },
    });
    await this.deps.graph.upsertEdge({
      from_urn: input.publication_urn,
      to_urn: artifactNodeUrn,
      predicate: 'sg:hasTransparencyReconciliation',
      properties: {
        reconciled_at: reconciledAt,
        status,
      },
    });

    return {
      publication_urn: input.publication_urn,
      log_id: intents[0]?.log_id ?? '',
      reconciled_at: reconciledAt,
      status,
      evidence_artifact_urn: artifactNodeUrn,
      evidence_sha256: evidence.sha256,
      outcomes,
    };
  }

  async compileSkillSource(input: {
    source_type: 'markdown' | 'tool_manifest';
    content: string;
    ontology_version?: string;
  }): Promise<import('../ports/registry-service.js').RegistryCompileSkillResult> {
    let compiled;
    try {
      compiled = input.source_type === 'markdown' ? compileMarkdownSkill(input.content) : compileToolManifest(input.content);
    } catch (err) {
      if (err instanceof SemanticCompileError) {
        throw new RegistryCoreError('SEMANTIC_COMPILE_INVALID', err.message);
      }
      throw err;
    }

    // Map extracted claims against the normative skill-area ontology when
    // one is resolved; unmapped terms are de facto candidates only.
    let document: OntologyDocument | null = null;
    if (input.ontology_version) {
      const node = await this.findOntologyPackageNode(input.ontology_version);
      if (node && node.properties['ontology_kind'] === 'skill_area') {
        const sha = stringOrUndefined(node.properties['sha256']);
        const stored = sha ? await this.deps.cas.getBySha256(sha) : null;
        if (stored) {
          try {
            const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: false }).decode(stored.bytes)) as {
              ontology?: unknown;
            };
            document = parseOntologyDocument(parsed.ontology);
          } catch {
            document = null;
          }
        }
      }
    }
    const mapping = document
      ? mapClaimsToOntology(compiled.capability_claims, document)
      : { mapped: [], unmapped: [...compiled.capability_claims] };
    return {
      compiled,
      ontology_mapping: {
        ontology_version: input.ontology_version ?? null,
        ontology_package_resolved: Boolean(document),
        mapped: mapping.mapped,
        unmapped: mapping.unmapped,
      },
    };
  }

  private async recordDeFactoCandidates(publicationUrn: string, candidates: string[]) {
    for (const term of candidates) {
      const urn = deFactoTermUrn(term);
      const existing = await this.deps.graph.getNode(urn);
      const examples = new Set<string>(
        existing && Array.isArray(existing.properties['example_publication_urns'])
          ? (existing.properties['example_publication_urns'] as string[])
          : [],
      );
      examples.add(publicationUrn);
      await this.deps.graph.upsertNode({
        urn,
        entity_type: 'DEFACTO_TERM',
        properties: {
          term,
          status: stringOrUndefined(existing?.properties['status']) ?? 'candidate',
          first_seen_at: stringOrUndefined(existing?.properties['first_seen_at']) ?? nowIso(),
          last_seen_at: nowIso(),
          seen_count: (typeof existing?.properties['seen_count'] === 'number' ? (existing.properties['seen_count'] as number) : 0) + 1,
          example_publication_urns: [...examples].slice(-10),
        },
      });
    }
  }

  async listDeFactoTerms(input?: { status?: 'candidate' | 'promoted' | 'rejected' }): Promise<{ terms: import('../ports/registry-service.js').RegistryDeFactoTermDetails[] }> {
    const nodes = await this.deps.graph.listNodesByType('DEFACTO_TERM');
    const terms = nodes
      .map((node) => this.toDeFactoTermDetails(node))
      .filter((term) => !input?.status || term.status === input.status);
    terms.sort((left, right) => left.term.localeCompare(right.term));
    return { terms };
  }

  private toDeFactoTermDetails(node: { urn: string; properties: Record<string, unknown> }): import('../ports/registry-service.js').RegistryDeFactoTermDetails {
    const status = node.properties['status'];
    return {
      urn: node.urn,
      term: stringOrUndefined(node.properties['term']) ?? '',
      status: status === 'promoted' || status === 'rejected' ? status : 'candidate',
      first_seen_at: stringOrUndefined(node.properties['first_seen_at']) ?? '',
      last_seen_at: stringOrUndefined(node.properties['last_seen_at']) ?? '',
      seen_count: typeof node.properties['seen_count'] === 'number' ? (node.properties['seen_count'] as number) : 0,
      example_publication_urns: Array.isArray(node.properties['example_publication_urns'])
        ? (node.properties['example_publication_urns'] as string[])
        : [],
      ...(stringOrUndefined(node.properties['reviewed_by']) ? { reviewed_by: String(node.properties['reviewed_by']) } : {}),
      ...(stringOrUndefined(node.properties['reviewed_at']) ? { reviewed_at: String(node.properties['reviewed_at']) } : {}),
      ...(stringOrUndefined(node.properties['promoted_into_ontology_version'])
        ? { promoted_into_ontology_version: String(node.properties['promoted_into_ontology_version']) }
        : {}),
    };
  }

  async reviewDeFactoTerm(input: {
    term: string;
    action: 'promote' | 'reject';
    author: string;
    source_ontology_version?: string;
    target_ontology_version?: string;
  }): Promise<import('../ports/registry-service.js').RegistryDeFactoTermDetails> {
    const urn = deFactoTermUrn(input.term);
    const existing = await this.deps.graph.getNode(urn);
    if (!existing) {
      throw new RegistryCoreError('DEFACTO_TERM_NOT_FOUND', `De facto term not found: ${input.term}`);
    }
    const currentStatus = stringOrUndefined(existing.properties['status']) ?? 'candidate';
    if (currentStatus !== 'candidate') {
      throw new RegistryCoreError('DEFACTO_TERM_REVIEW_CONFLICT', `De facto term already reviewed: ${input.term} (${currentStatus})`);
    }

    if (input.action === 'reject') {
      await this.deps.graph.upsertNode({
        urn,
        entity_type: 'DEFACTO_TERM',
        properties: {
          ...existing.properties,
          status: 'rejected',
          reviewed_by: input.author,
          reviewed_at: nowIso(),
        },
      });
    } else {
      // Promotion requires human review plus normative incorporation: the
      // term is appended to a NEW version of an existing skill-area
      // ontology package. Source packages stay immutable.
      if (!input.source_ontology_version || !input.target_ontology_version) {
        throw new RegistryCoreError(
          'DEFACTO_TERM_PROMOTE_INVALID',
          'Promotion requires source_ontology_version and target_ontology_version.',
        );
      }
      const sourceNode = await this.findOntologyPackageNode(input.source_ontology_version);
      if (!sourceNode || sourceNode.properties['ontology_kind'] !== 'skill_area') {
        throw new RegistryCoreError('ONTOLOGY_PACKAGE_NOT_FOUND', `Skill-area ontology package not found: ${input.source_ontology_version}`);
      }
      const sha = stringOrUndefined(sourceNode.properties['sha256']);
      const stored = sha ? await this.deps.cas.getBySha256(sha) : null;
      if (!stored) {
        throw new RegistryCoreError('ONTOLOGY_PACKAGE_NOT_FOUND', `Ontology package content not found: ${input.source_ontology_version}`);
      }
      const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: false }).decode(stored.bytes)) as { ontology?: unknown };
      const document = parseOntologyDocument(parsed.ontology);
      if (document.concepts.some((concept) => concept.id === input.term)) {
        throw new RegistryCoreError('DEFACTO_TERM_PROMOTE_CONFLICT', `Term already exists in ontology: ${input.term}`);
      }
      await this.createOntologyPackage({
        ontology_version: input.target_ontology_version,
        author: input.author,
        ontology: {
          kind: 'skill_area',
          concepts: [...document.concepts, { id: input.term }],
          disjoint: document.disjoint,
        },
        ...(stringOrUndefined(sourceNode.properties['description'])
          ? { description: String(sourceNode.properties['description']) }
          : {}),
      });
      await this.deps.graph.upsertNode({
        urn,
        entity_type: 'DEFACTO_TERM',
        properties: {
          ...existing.properties,
          status: 'promoted',
          reviewed_by: input.author,
          reviewed_at: nowIso(),
          promoted_into_ontology_version: input.target_ontology_version,
        },
      });
    }

    const updated = await this.deps.graph.getNode(urn);
    if (!updated) {
      throw new RegistryCoreError('DEFACTO_TERM_REVIEW_FAILED', 'Failed to update de facto term.');
    }
    return this.toDeFactoTermDetails(updated);
  }

  async getGovernanceLogState(): Promise<import('../ports/registry-service.js').RegistryGovernanceLogState> {
    const node = await this.deps.graph.getNode(GOVERNANCE_LOG_URN);
    const leafHashes = node && Array.isArray(node.properties['leaf_hashes']) ? (node.properties['leaf_hashes'] as string[]) : [];
    const eventUrns = node && Array.isArray(node.properties['event_artifact_urns']) ? (node.properties['event_artifact_urns'] as string[]) : [];
    return {
      log_id: 'registry-governance',
      tree_size: leafHashes.length,
      root_hash: leafHashes.length > 0 ? computeMerkleRoot(leafHashes) : null,
      ...(node && stringOrUndefined(node.properties['updated_at'])
        ? { updated_at: String(node.properties['updated_at']) }
        : {}),
      leaves: leafHashes.map((leafHash, index) => ({
        leaf_index: index,
        leaf_hash: leafHash,
        ...(eventUrns[index] ? { event_artifact_urn: eventUrns[index] as string } : {}),
      })),
    };
  }

  async getGovernanceLogProof(input: { leaf_index: number }): Promise<import('../ports/registry-service.js').RegistryGovernanceLogProof | null> {
    const node = await this.deps.graph.getNode(GOVERNANCE_LOG_URN);
    const leafHashes = node && Array.isArray(node.properties['leaf_hashes']) ? (node.properties['leaf_hashes'] as string[]) : [];
    if (input.leaf_index < 0 || input.leaf_index >= leafHashes.length) return null;
    const eventUrns = node && Array.isArray(node.properties['event_artifact_urns']) ? (node.properties['event_artifact_urns'] as string[]) : [];
    const proof = generateInclusionProof(leafHashes, input.leaf_index);
    return {
      log_id: 'registry-governance',
      leaf_index: input.leaf_index,
      tree_size: leafHashes.length,
      leaf_hash: `hex:${leafHashes[input.leaf_index]}`,
      proof_hashes: proof.map((hash) => `hex:${hash}`),
      root_hash: `hex:${computeMerkleRoot(leafHashes)}`,
      ...(eventUrns[input.leaf_index] ? { event_artifact_urn: eventUrns[input.leaf_index] as string } : {}),
    };
  }

  async replayGovernanceLog(): Promise<import('../ports/registry-service.js').RegistryGovernanceLogReplay> {
    const node = await this.deps.graph.getNode(GOVERNANCE_LOG_URN);
    const leafHashes = node && Array.isArray(node.properties['leaf_hashes']) ? (node.properties['leaf_hashes'] as string[]) : [];
    const recomputed = leafHashes.length > 0 ? computeMerkleRoot(leafHashes) : null;
    const recorded = node ? (stringOrUndefined(node.properties['root_hash']) ?? null) : null;
    return {
      log_id: 'registry-governance',
      tree_size: leafHashes.length,
      recorded_root_hash: recorded,
      recomputed_root_hash: recomputed,
      consistent: recorded === recomputed,
    };
  }

  private async publishCanonicalRdfArtifact(input: {
    publication_urn: string;
    logical_urn: string;
    properties: Record<string, unknown>;
  }): Promise<{ artifact_urn: string; sha256: string }> {
    // Edges excluded from the projected graph: sg:hasCanonicalRdf is a
    // self-reference to the projection artifact, prov:wasGeneratedBy is
    // attached by the task hook after publication, detached signatures must
    // reside outside the canonical payload they sign, and sg:hasPublicationEnvelope
    // references the frozen operational envelope artifact.
    const edges = (await this.deps.graph.listEdgesFrom(input.publication_urn)).filter(
      (edge) =>
        edge.predicate !== 'sg:hasCanonicalRdf' &&
        edge.predicate !== 'prov:wasGeneratedBy' &&
        edge.predicate !== 'sg:hasDetachedSignature' &&
        edge.predicate !== 'sg:hasPublicationEnvelope',
    );
    let lines: string[];
    try {
      lines = projectPublicationGraphToNQuads({
        publication_urn: input.publication_urn,
        logical_urn: input.logical_urn,
        properties: omitProperties(input.properties, PUBLICATION_PROJECTION_PROP_KEYS),
        edges: edges.map((edge) => ({ predicate: edge.predicate, to_urn: edge.to_urn })),
      });
    } catch (err) {
      throw new RegistryCoreError(
        'CANONICAL_RDF_INVALID_IRI',
        err instanceof Error ? err.message : 'Publication graph contains an invalid IRI.',
      );
    }
    const { nquads, sha256 } = await computeCanonicalRdf(lines);
    const artifact = await this.deps.cas.put({
      bytes: Buffer.from(nquads, 'utf8'),
      media_type: 'application/n-quads',
      original_path: `generated/canonical-rdf/${sanitizePathSegment(input.publication_urn)}.nq`,
    });
    const artifactNodeUrn = artifactUrn(artifact.sha256);
    await this.deps.graph.upsertNode({
      urn: artifactNodeUrn,
      entity_type: 'ARTIFACT',
      properties: {
        sha256: artifact.sha256,
        size_bytes: artifact.size_bytes,
        media_type: artifact.media_type,
        original_path: artifact.original_path,
        governance_role: 'canonical_rdf',
      },
    });
    await this.deps.graph.upsertEdge({
      from_urn: input.publication_urn,
      to_urn: artifactNodeUrn,
      predicate: 'sg:hasCanonicalRdf',
      properties: {},
    });
    return { artifact_urn: artifactNodeUrn, sha256 };
  }

  private async attachGovernanceArtifacts(
    publicationUrn: string,
    artifacts: Array<{
      role: 'policy_package' | 'validation_report' | 'certification_evidence' | 'review_evidence' | 'review_evidence';
      artifact_urn: string;
      sha256?: string;
    }>,
  ) {
    for (const artifact of artifacts) {
      await this.deps.graph.upsertEdge({
        from_urn: publicationUrn,
        to_urn: artifact.artifact_urn,
        predicate:
          artifact.role === 'policy_package'
            ? 'sg:governedByPolicy'
            : artifact.role === 'validation_report'
              ? 'sg:validatedBy'
              : artifact.role === 'review_evidence'
                ? 'sg:reviewedBy'
                : 'sg:certificationEvidence',
        properties: {},
      });
    }
  }

  private async loadGovernanceArtifacts(publicationUrn: string) {
    const node = await this.deps.graph.getNode(publicationUrn);
    if (!node) return [] as import('../ports/registry-service.js').RegistryGovernanceArtifactRef[];
    const policyEdges = await this.deps.graph.listEdgesFrom(node.urn, 'sg:governedByPolicy');
    const validationEdges = await this.deps.graph.listEdgesFrom(node.urn, 'sg:validatedBy');
    const certificationEdges = await this.deps.graph.listEdgesFrom(node.urn, 'sg:certificationEvidence');
    const reviewEdges = await this.deps.graph.listEdgesFrom(node.urn, 'sg:reviewedBy');
    // Edge iteration order is backend-dependent (Fuseki gives no ordering
    // guarantee), so impose the shared total order here: every envelope
    // derivation must agree byte-for-byte with the prepared candidate.
    return sortGovernanceArtifactRefs([
      ...(await this.mapGovernanceArtifacts(policyEdges, 'policy_package')),
      ...(await this.mapGovernanceArtifacts(validationEdges, 'validation_report')),
      ...(await this.mapGovernanceArtifacts(certificationEdges, 'certification_evidence')),
      ...(await this.mapGovernanceArtifacts(reviewEdges, 'review_evidence')),
    ]);
  }

  private async mapGovernanceArtifacts(
    edges: Array<{ to_urn: string }>,
    role: 'policy_package' | 'validation_report' | 'certification_evidence' | 'review_evidence',
  ) {
    const values = await Promise.all(
      edges.map(async (edge) => {
        const artifactNode = await this.deps.graph.getNode(edge.to_urn);
        return {
          role,
          artifact_urn: edge.to_urn,
          ...(toOptionalStringProp('sha256', parseArtifactSha256(edge.to_urn))),
          ...(artifactNode ? maybeTransparencyAppendIntentProp(artifactNode.properties) : {}),
        } satisfies import('../ports/registry-service.js').RegistryGovernanceArtifactRef;
      }),
    );
    return values;
  }

  private async recordPublicationAppendIntent(input: {
    publication_urn: string;
    logical_key: string;
    entity_type: 'AGENT_VERSION' | 'SKILL_VERSION';
    note: string;
  }) {
    if (!this.deps.appendIntentPublisher) return;
    const envelope =
      input.entity_type === 'AGENT_VERSION'
        ? await this.getAgentPublicationEnvelope({
            agent_key: extractLogicalKeyFromPublicationUrn(input.publication_urn),
            version: extractVersionFromPublicationUrn(input.publication_urn),
          })
        : await this.getSkillPublicationEnvelope({
            skill_key: extractLogicalKeyFromPublicationUrn(input.publication_urn),
            version: extractVersionFromPublicationUrn(input.publication_urn),
          });
    if (!envelope) return;
    const appendIntent = await this.deps.appendIntentPublisher.publishAppendIntent({
      source_urn: input.publication_urn,
      source_type: 'publication_envelope',
      digest: envelope.canonical_json_sha256,
      digest_algorithm: 'sha256',
      content_type: 'application/json',
      note: input.note,
      payload: {
        publication_urn: envelope.publication_urn,
        logical_urn: envelope.logical_urn,
        entity_type: envelope.entity_type,
        canonical_json_sha256: envelope.canonical_json_sha256,
        governance_artifact_urns: envelope.governance_artifacts.map((artifact) => artifact.artifact_urn),
      },
    });
    const appendIntentWithArtifact = await this.attachCheckpointArtifactToAppendIntent(appendIntent, input.logical_key);
    const publicationNode = await this.deps.graph.getNode(input.publication_urn);
    if (!publicationNode) return;
    await this.deps.graph.upsertNode({
      urn: publicationNode.urn,
      entity_type: publicationNode.entity_type,
      properties: {
        ...publicationNode.properties,
        ...transparencyAppendIntentProps(appendIntentWithArtifact),
      },
    });
  }

  private async attachGovernanceArtifactAppendIntent(input: {
    artifact_urn: string;
    role:
      | 'policy_package'
      | 'validation_report'
      | 'certification_evidence'
      | 'review_evidence'
      | 'provenance_signature'
      | 'provenance_export'
      | 'validation_report_rdf'
      | 'validation_report_signature';
    logical_key: string;
    publication_urn: string;
    sha256: string;
    payload: Record<string, unknown>;
  }) {
    if (!this.deps.appendIntentPublisher) return;
    const appendIntent = await this.deps.appendIntentPublisher.publishAppendIntent({
      source_urn: input.artifact_urn,
      source_type: 'governance_event',
      digest: input.sha256,
      digest_algorithm: 'sha256',
      content_type: 'application/json',
      note: input.role,
      payload: {
        role: input.role,
        logical_key: input.logical_key,
        publication_urn: input.publication_urn,
        artifact_urn: input.artifact_urn,
        payload: input.payload,
      },
    });
    const appendIntentWithArtifact = await this.attachCheckpointArtifactToAppendIntent(
      appendIntent,
      `${input.logical_key}-${input.role}`,
    );
    const artifactNode = await this.deps.graph.getNode(input.artifact_urn);
    if (!artifactNode) return;
    await this.deps.graph.upsertNode({
      urn: artifactNode.urn,
      entity_type: artifactNode.entity_type,
      properties: {
        ...artifactNode.properties,
        ...transparencyAppendIntentProps(appendIntentWithArtifact),
      },
    });
  }

  private async attachCheckpointArtifactToAppendIntent(
    appendIntent: import('../ports/registry-service.js').RegistryTransparencyAppendIntentRef,
    logicalKey: string,
  ) {
    if (!appendIntent.tessera_checkpoint_url || !appendIntent.tessera_checkpoint_note_sha256) {
      return appendIntent;
    }
    try {
      // The URL originates from the sidecar/runtime response; keep the fetch
      // bounded and pinned: only http(s), no redirects, hard timeout.
      let checkpointUrl: URL;
      try {
        checkpointUrl = new URL(appendIntent.tessera_checkpoint_url);
      } catch {
        return appendIntent;
      }
      if (checkpointUrl.protocol !== 'http:' && checkpointUrl.protocol !== 'https:') {
        return appendIntent;
      }
      const response = await fetch(checkpointUrl, {
        redirect: 'error',
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) {
        return appendIntent;
      }
      const text = await response.text();
      const bytes = Buffer.from(text, 'utf8');
      const sha256 = sha256Hex(bytes);
      if (sha256 !== appendIntent.tessera_checkpoint_note_sha256) {
        return appendIntent;
      }
      const artifact = await this.deps.cas.put({
        bytes,
        media_type: 'text/plain',
        original_path: `generated/tessera-checkpoint/${sanitizePathSegment(logicalKey)}.txt`,
      });
      const artifactUrnValue = artifactUrn(artifact.sha256);
      await this.deps.graph.upsertNode({
        urn: artifactUrnValue,
        entity_type: 'ARTIFACT',
        properties: {
          sha256: artifact.sha256,
          size_bytes: artifact.size_bytes,
          media_type: artifact.media_type,
          original_path: artifact.original_path,
          governance_role: 'tessera_checkpoint_note',
          log_id: appendIntent.log_id,
          ...(typeof appendIntent.tessera_checkpoint_tree_size === 'number'
            ? { tree_size: appendIntent.tessera_checkpoint_tree_size }
            : {}),
          ...(appendIntent.tessera_checkpoint_root_hash ? { root_hash: appendIntent.tessera_checkpoint_root_hash } : {}),
          checkpoint_url: appendIntent.tessera_checkpoint_url,
        },
      });
      return {
        ...appendIntent,
        tessera_checkpoint_artifact_urn: artifactUrnValue,
      };
    } catch {
      return appendIntent;
    }
  }

  async getPublicationVerification(input: { publication_urn: string }): Promise<RegistryPublicationVerification | null> {
    const node = await this.deps.graph.getNode(input.publication_urn);
    if (!node || (node.entity_type !== 'SKILL_VERSION' && node.entity_type !== 'AGENT_VERSION')) {
      return null;
    }
    try {
      const logicalKey = extractLogicalKeyFromPublicationUrn(node.urn);
      const version = extractVersionFromPublicationUrn(node.urn);
      return node.entity_type === 'SKILL_VERSION'
        ? await this.getSkillPublicationVerification({ skill_key: logicalKey, version })
        : await this.getAgentPublicationVerification({ agent_key: logicalKey, version });
    } catch {
      // A malformed publication URN is reported as not found, mirroring the
      // provenance lookup behaviour.
      return null;
    }
  }

  async createAgentProvenanceSignature(
    input: { agent_key: string; version: number } & import('../ports/registry-service.js').RegistryProvenanceSignatureInput,
  ): Promise<CreateResult<import('../ports/registry-service.js').RegistryProvenanceSignatureRecord>> {
    const version = await this.getAgentVersion(input);
    if (!version) {
      throw new RegistryCoreError('AGENT_VERSION_NOT_FOUND', 'Agent version not found.');
    }
    return await this.attachProvenanceSignature({
      publication_urn: version.agent_version.urn,
      logical_key: input.agent_key,
      errorPrefix: 'AGENT_VERSION',
      signature: input,
    });
  }

  async createSkillProvenanceSignature(
    input: { skill_key: string; version: number } & import('../ports/registry-service.js').RegistryProvenanceSignatureInput,
  ): Promise<CreateResult<import('../ports/registry-service.js').RegistryProvenanceSignatureRecord>> {
    const version = await this.getSkillVersion(input);
    if (!version) {
      throw new RegistryCoreError('SKILL_VERSION_NOT_FOUND', 'Skill version not found.');
    }
    return await this.attachProvenanceSignature({
      publication_urn: version.skill_version.urn,
      logical_key: input.skill_key,
      errorPrefix: 'SKILL_VERSION',
      signature: input,
    });
  }

  /**
   * Attach a detached signature over the canonical provenance export.
   * Fail-closed: the key must resolve to a trusted, unexpired key and the
   * signature must verify over the current canonical N-Quads; an explicit
   * digest differing from the current export is rejected as stale so
   * signers re-fetch (provenance grows with every lifecycle operation).
   * Trusted keys only in v1 — keyless bundles need prepared signed bytes.
   */
  private async attachProvenanceSignature(input: {
    publication_urn: string;
    logical_key: string;
    errorPrefix: 'SKILL_VERSION' | 'AGENT_VERSION';
    signature: import('../ports/registry-service.js').RegistryProvenanceSignatureInput;
  }): Promise<CreateResult<import('../ports/registry-service.js').RegistryProvenanceSignatureRecord>> {
    const provenance = await this.getPublicationProvenance({ publication_urn: input.publication_urn });
    if (!provenance) {
      throw new RegistryCoreError(
        `${input.errorPrefix}_PROVENANCE_SIGNATURE_CONFLICT`,
        'Provenance is not available for this version.',
      );
    }
    const provenance_sha256 = provenance.evidence.canonical_rdf_sha256;
    if (input.signature.provenance_sha256 && input.signature.provenance_sha256 !== provenance_sha256) {
      throw new RegistryCoreError(
        `${input.errorPrefix}_PROVENANCE_SIGNATURE_STALE`,
        'The supplied provenance digest is not the current export; re-fetch the provenance and sign the current canonical bytes.',
      );
    }
    const resolvedKey = await this.resolveTrustedPublicKeyMaterial(input.signature.key_ref);
    if (!resolvedKey) {
      throw new RegistryCoreError(
        `${input.errorPrefix}_PROVENANCE_SIGNATURE_KEY_UNTRUSTED`,
        'Signature key_ref does not resolve to a trusted, unexpired public key.',
      );
    }
    const canonicalArtifact = await this.readCasArtifact(provenance_sha256);
    const canonicalBytes = canonicalArtifact ? Buffer.from(canonicalArtifact.bytes) : null;
    if (!canonicalBytes) {
      throw new RegistryCoreError(
        `${input.errorPrefix}_PROVENANCE_SIGNATURE_CONFLICT`,
        'Canonical provenance export could not be read.',
      );
    }
    const verified = verifyDetachedSignatureBytes({
      algorithm: input.signature.algorithm,
      public_key_pem: resolvedKey.public_key_pem,
      message: canonicalBytes.toString('utf8'),
      signature: input.signature.signature,
    });
    if (!verified) {
      throw new RegistryCoreError(
        `${input.errorPrefix}_PROVENANCE_SIGNATURE_INVALID`,
        'Signature does not verify over the canonical provenance bytes for this version.',
      );
    }

    // Idempotent for an identical re-attach; conflicting duplicates fail.
    const existingEdges = await this.deps.graph.listEdgesFrom(input.publication_urn, 'sg:hasProvenanceSignature');
    for (const edge of existingEdges) {
      const node = await this.deps.graph.getNode(edge.to_urn);
      if (
        node &&
        stringOrUndefined(node.properties['key_ref']) === input.signature.key_ref &&
        stringOrUndefined(node.properties['provenance_sha256']) === provenance_sha256
      ) {
        if (stringOrUndefined(node.properties['signature']) === input.signature.signature) {
          return { created: false, value: this.toProvenanceSignatureRecord(node) };
        }
        throw new RegistryCoreError(
          `${input.errorPrefix}_PROVENANCE_SIGNATURE_CONFLICT`,
          'A different provenance signature from this key already exists for the current export.',
        );
      }
    }

    const signed_at = nowIso();
    const content = canonicalJsonString({
      publication_urn: input.publication_urn,
      signer: input.signature.signer,
      key_ref: input.signature.key_ref,
      algorithm: input.signature.algorithm,
      signed_at,
      provenance_sha256,
      signature: input.signature.signature,
    });
    const artifact = await this.deps.cas.put({
      bytes: Buffer.from(content, 'utf8'),
      media_type: 'application/json',
      original_path: `generated/provenance-signature/${sanitizePathSegment(input.logical_key)}.json`,
    });
    const artifactNodeUrn = artifactUrn(artifact.sha256);
    await this.deps.graph.upsertNode({
      urn: artifactNodeUrn,
      entity_type: 'ARTIFACT',
      properties: {
        sha256: artifact.sha256,
        size_bytes: artifact.size_bytes,
        media_type: artifact.media_type,
        original_path: artifact.original_path,
        governance_role: 'provenance_signature',
        signer: input.signature.signer,
        key_ref: input.signature.key_ref,
        algorithm: input.signature.algorithm,
        signed_at,
        provenance_sha256,
        signature: input.signature.signature,
      },
    });
    await this.deps.graph.upsertEdge({
      from_urn: input.publication_urn,
      to_urn: artifactNodeUrn,
      predicate: 'sg:hasProvenanceSignature',
      properties: {},
    });

    // Transparency: stage the signature record AND the signed export digest
    // through the sidecar (best-effort, like lifecycle events). The export
    // artifact gets a lightweight node so reconciliation can find its intent
    // via this signature's provenance_sha256.
    await this.attachGovernanceArtifactAppendIntent({
      artifact_urn: artifactNodeUrn,
      role: 'provenance_signature',
      logical_key: input.logical_key,
      publication_urn: input.publication_urn,
      sha256: artifact.sha256,
      payload: {
        publication_urn: input.publication_urn,
        provenance_sha256,
        signer: input.signature.signer,
        key_ref: input.signature.key_ref,
      },
    });
    const exportArtifactNodeUrn = artifactUrn(provenance_sha256);
    await this.deps.graph.upsertNode({
      urn: exportArtifactNodeUrn,
      entity_type: 'ARTIFACT',
      properties: {
        sha256: provenance_sha256,
        governance_role: 'provenance_export',
        publication_urn: input.publication_urn,
      },
    });
    await this.attachGovernanceArtifactAppendIntent({
      artifact_urn: exportArtifactNodeUrn,
      role: 'provenance_export',
      logical_key: input.logical_key,
      publication_urn: input.publication_urn,
      sha256: provenance_sha256,
      payload: { publication_urn: input.publication_urn },
    });

    const node = await this.deps.graph.getNode(artifactNodeUrn);
    if (!node) {
      throw new RegistryCoreError(
        `${input.errorPrefix}_PROVENANCE_SIGNATURE_CONFLICT`,
        'Failed to store the provenance signature.',
      );
    }
    return { created: true, value: this.toProvenanceSignatureRecord(node) };
  }

  private toProvenanceSignatureRecord(node: {
    urn: string;
    properties: Record<string, unknown>;
  }): import('../ports/registry-service.js').RegistryProvenanceSignatureRecord {
    return {
      artifact_urn: node.urn,
      ...toOptionalStringProp('sha256', stringOrUndefined(node.properties['sha256']) ?? parseArtifactSha256(node.urn)),
      signer: String(node.properties['signer'] ?? ''),
      key_ref: String(node.properties['key_ref'] ?? ''),
      algorithm: String(node.properties['algorithm'] ?? ''),
      signed_at: String(node.properties['signed_at'] ?? ''),
      provenance_sha256: String(node.properties['provenance_sha256'] ?? ''),
      signature: String(node.properties['signature'] ?? ''),
    };
  }

  async createAgentReportSignature(
    input: { agent_key: string; version: number } & import('../ports/registry-service.js').RegistryReportSignatureInput,
  ): Promise<CreateResult<import('../ports/registry-service.js').RegistryReportSignatureRecord>> {
    const version = await this.getAgentVersion(input);
    if (!version) {
      throw new RegistryCoreError('AGENT_VERSION_NOT_FOUND', 'Agent version not found.');
    }
    return await this.attachReportSignature({
      publication_urn: version.agent_version.urn,
      logical_key: input.agent_key,
      errorPrefix: 'AGENT_VERSION',
      signature: input,
    });
  }

  async createSkillReportSignature(
    input: { skill_key: string; version: number } & import('../ports/registry-service.js').RegistryReportSignatureInput,
  ): Promise<CreateResult<import('../ports/registry-service.js').RegistryReportSignatureRecord>> {
    const version = await this.getSkillVersion(input);
    if (!version) {
      throw new RegistryCoreError('SKILL_VERSION_NOT_FOUND', 'Skill version not found.');
    }
    return await this.attachReportSignature({
      publication_urn: version.skill_version.urn,
      logical_key: input.skill_key,
      errorPrefix: 'SKILL_VERSION',
      signature: input,
    });
  }

  /**
   * Attach a detached signature over a specific validation report artifact's
   * canonical RDF export. Fail-closed: the target must be one of the
   * version's `sg:validatedBy` reports carrying an RDF representation, the
   * key must resolve to a trusted, unexpired key, and the signature must
   * verify over the canonical N-Quads bytes. Reports are immutable, so
   * signatures are valid or invalid — never stale.
   */
  private async attachReportSignature(input: {
    publication_urn: string;
    logical_key: string;
    errorPrefix: 'SKILL_VERSION' | 'AGENT_VERSION';
    signature: import('../ports/registry-service.js').RegistryReportSignatureInput;
  }): Promise<CreateResult<import('../ports/registry-service.js').RegistryReportSignatureRecord>> {
    const governanceRefs = await this.loadGovernanceArtifacts(input.publication_urn);
    const reportRefs = governanceRefs.filter((ref) => ref.role === 'validation_report');
    const target = reportRefs.find((ref) => ref.artifact_urn === input.signature.report_artifact_urn);
    if (!target) {
      throw new RegistryCoreError(
        `${input.errorPrefix}_REPORT_SIGNATURE_TARGET_INVALID`,
        'The report_artifact_urn is not one of this version\'s validation report artifacts.',
      );
    }
    const reportBytes = await this.getArtifactBytes({ artifact_urn: target.artifact_urn });
    let reportCanonicalSha: string | null = null;
    if (reportBytes) {
      try {
        const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: false }).decode(reportBytes.bytes)) as {
          payload?: { validator?: string; rdf?: { canonical_rdf_sha256?: string } };
        };
        if (parsed.payload?.validator === 'shacl-v1' && typeof parsed.payload.rdf?.canonical_rdf_sha256 === 'string') {
          reportCanonicalSha = parsed.payload.rdf.canonical_rdf_sha256;
        }
      } catch {
        reportCanonicalSha = null;
      }
    }
    if (!reportCanonicalSha) {
      throw new RegistryCoreError(
        `${input.errorPrefix}_REPORT_SIGNATURE_TARGET_INVALID`,
        'The target report has no standardized RDF representation to sign.',
      );
    }
    const resolvedKey = await this.resolveTrustedPublicKeyMaterial(input.signature.key_ref);
    if (!resolvedKey) {
      throw new RegistryCoreError(
        `${input.errorPrefix}_REPORT_SIGNATURE_KEY_UNTRUSTED`,
        'Signature key_ref does not resolve to a trusted, unexpired public key.',
      );
    }
    const canonicalArtifact = await this.readCasArtifact(reportCanonicalSha);
    const canonicalBytes = canonicalArtifact ? Buffer.from(canonicalArtifact.bytes) : null;
    if (!canonicalBytes) {
      throw new RegistryCoreError(
        `${input.errorPrefix}_REPORT_SIGNATURE_TARGET_INVALID`,
        'The report canonical RDF artifact could not be read.',
      );
    }
    const verified = verifyDetachedSignatureBytes({
      algorithm: input.signature.algorithm,
      public_key_pem: resolvedKey.public_key_pem,
      message: canonicalBytes.toString('utf8'),
      signature: input.signature.signature,
    });
    if (!verified) {
      throw new RegistryCoreError(
        `${input.errorPrefix}_REPORT_SIGNATURE_INVALID`,
        'Signature does not verify over the report canonical RDF bytes.',
      );
    }

    // Idempotent for an identical re-attach; conflicting duplicates fail.
    const existingEdges = await this.deps.graph.listEdgesFrom(input.publication_urn, 'sg:hasReportSignature');
    for (const edge of existingEdges) {
      const node = await this.deps.graph.getNode(edge.to_urn);
      if (
        node &&
        stringOrUndefined(node.properties['key_ref']) === input.signature.key_ref &&
        stringOrUndefined(node.properties['report_canonical_rdf_sha256']) === reportCanonicalSha
      ) {
        if (stringOrUndefined(node.properties['signature']) === input.signature.signature) {
          return { created: false, value: this.toReportSignatureRecord(node) };
        }
        throw new RegistryCoreError(
          `${input.errorPrefix}_REPORT_SIGNATURE_CONFLICT`,
          'A different report signature from this key already exists for this report.',
        );
      }
    }

    const signed_at = nowIso();
    const content = canonicalJsonString({
      publication_urn: input.publication_urn,
      report_artifact_urn: target.artifact_urn,
      report_canonical_rdf_sha256: reportCanonicalSha,
      signer: input.signature.signer,
      key_ref: input.signature.key_ref,
      algorithm: input.signature.algorithm,
      signed_at,
      signature: input.signature.signature,
    });
    const artifact = await this.deps.cas.put({
      bytes: Buffer.from(content, 'utf8'),
      media_type: 'application/json',
      original_path: `generated/report-signature/${sanitizePathSegment(input.logical_key)}.json`,
    });
    const artifactNodeUrn = artifactUrn(artifact.sha256);
    await this.deps.graph.upsertNode({
      urn: artifactNodeUrn,
      entity_type: 'ARTIFACT',
      properties: {
        sha256: artifact.sha256,
        size_bytes: artifact.size_bytes,
        media_type: artifact.media_type,
        original_path: artifact.original_path,
        governance_role: 'validation_report_signature',
        signer: input.signature.signer,
        key_ref: input.signature.key_ref,
        algorithm: input.signature.algorithm,
        signed_at,
        report_artifact_urn: target.artifact_urn,
        report_canonical_rdf_sha256: reportCanonicalSha,
        signature: input.signature.signature,
      },
    });
    await this.deps.graph.upsertEdge({
      from_urn: input.publication_urn,
      to_urn: artifactNodeUrn,
      predicate: 'sg:hasReportSignature',
      properties: {},
    });
    await this.attachGovernanceArtifactAppendIntent({
      artifact_urn: artifactNodeUrn,
      role: 'validation_report_signature',
      logical_key: input.logical_key,
      publication_urn: input.publication_urn,
      sha256: artifact.sha256,
      payload: {
        publication_urn: input.publication_urn,
        report_artifact_urn: target.artifact_urn,
        report_canonical_rdf_sha256: reportCanonicalSha,
        signer: input.signature.signer,
        key_ref: input.signature.key_ref,
      },
    });
    const node = await this.deps.graph.getNode(artifactNodeUrn);
    if (!node) {
      throw new RegistryCoreError(
        `${input.errorPrefix}_REPORT_SIGNATURE_CONFLICT`,
        'Failed to store the report signature.',
      );
    }
    return { created: true, value: this.toReportSignatureRecord(node) };
  }

  private toReportSignatureRecord(node: {
    urn: string;
    properties: Record<string, unknown>;
  }): import('../ports/registry-service.js').RegistryReportSignatureRecord {
    return {
      artifact_urn: node.urn,
      ...toOptionalStringProp('sha256', stringOrUndefined(node.properties['sha256']) ?? parseArtifactSha256(node.urn)),
      signer: String(node.properties['signer'] ?? ''),
      key_ref: String(node.properties['key_ref'] ?? ''),
      algorithm: String(node.properties['algorithm'] ?? ''),
      signed_at: String(node.properties['signed_at'] ?? ''),
      report_artifact_urn: String(node.properties['report_artifact_urn'] ?? ''),
      report_canonical_rdf_sha256: String(node.properties['report_canonical_rdf_sha256'] ?? ''),
      signature: String(node.properties['signature'] ?? ''),
    };
  }

  /**
   * Re-verify every stored report signature on read: the target report and
   * its canonical artifact must be retrievable (and the report must still
   * declare the signed digest), the key must resolve, and the crypto must
   * pass — otherwise the row is `invalid`.
   */
  private async buildReportSignatureChecks(
    publicationUrn: string,
  ): Promise<import('../ports/registry-service.js').RegistryReportSignatureVerification[]> {
    const edges = await this.deps.graph.listEdgesFrom(publicationUrn, 'sg:hasReportSignature');
    const checks: import('../ports/registry-service.js').RegistryReportSignatureVerification[] = [];
    for (const edge of edges) {
      const node = await this.deps.graph.getNode(edge.to_urn);
      if (!node || node.entity_type !== 'ARTIFACT') continue;
      const signer = stringOrUndefined(node.properties['signer']);
      const key_ref = stringOrUndefined(node.properties['key_ref']);
      const algorithm = stringOrUndefined(node.properties['algorithm']);
      const signed_at = stringOrUndefined(node.properties['signed_at']);
      const report_artifact_urn = stringOrUndefined(node.properties['report_artifact_urn']);
      const report_canonical_rdf_sha256 = stringOrUndefined(node.properties['report_canonical_rdf_sha256']);
      const signature = stringOrUndefined(node.properties['signature']);
      if (
        !signer ||
        !key_ref ||
        !algorithm ||
        !signed_at ||
        !report_artifact_urn ||
        !report_canonical_rdf_sha256 ||
        !signature
      ) {
        continue;
      }

      let report_artifact_present = false;
      const reportSha = parseArtifactSha256(report_artifact_urn);
      if (reportSha) {
        try {
          const reportBytes = await this.readCasArtifact(reportSha);
          if (reportBytes) {
            const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: false }).decode(reportBytes.bytes)) as {
              payload?: { rdf?: { canonical_rdf_sha256?: string } };
            };
            report_artifact_present = parsed.payload?.rdf?.canonical_rdf_sha256 === report_canonical_rdf_sha256;
          }
        } catch {
          report_artifact_present = false;
        }
      }
      let canonicalBytes: Buffer | null = null;
      try {
        const canonicalArtifact = await this.readCasArtifact(report_canonical_rdf_sha256);
        canonicalBytes = canonicalArtifact ? Buffer.from(canonicalArtifact.bytes) : null;
      } catch {
        canonicalBytes = null;
      }
      const resolvedKey = await this.resolveTrustedPublicKeyMaterial(key_ref);
      const cryptographic_verification_passed =
        canonicalBytes !== null && resolvedKey
          ? verifyDetachedSignatureBytes({
              algorithm,
              public_key_pem: resolvedKey.public_key_pem,
              message: canonicalBytes.toString('utf8'),
              signature,
            })
          : false;
      const verdict: 'valid' | 'invalid' =
        report_artifact_present &&
        canonicalBytes !== null &&
        resolvedKey &&
        cryptographic_verification_passed
          ? 'valid'
          : 'invalid';
      checks.push({
        artifact_urn: node.urn,
        signer,
        key_ref,
        algorithm,
        signed_at,
        report_artifact_urn,
        report_canonical_rdf_sha256,
        report_artifact_present,
        canonical_artifact_present: canonicalBytes !== null,
        trusted_public_key_resolved: Boolean(resolvedKey),
        cryptographic_verification_passed,
        verdict,
      });
    }
    checks.sort(
      (left, right) =>
        left.key_ref.localeCompare(right.key_ref) ||
        left.signed_at.localeCompare(right.signed_at) ||
        left.artifact_urn.localeCompare(right.artifact_urn),
    );
    return checks;
  }

  async getPublicationReportSignatures(input: {
    publication_urn: string;
  }): Promise<import('../ports/registry-service.js').RegistryReportSignatureVerification[]> {
    return await this.buildReportSignatureChecks(input.publication_urn);
  }

  async getPublicationProvenance(input: { publication_urn: string }): Promise<import('../ports/registry-service.js').RegistryPublicationProvenance | null> {
    const start = await this.deps.graph.getNode(input.publication_urn);
    if (!start || (start.entity_type !== 'SKILL_VERSION' && start.entity_type !== 'AGENT_VERSION')) {
      return null;
    }

    // Walk the prov:wasDerivedFrom chain back to the original submission.
    const chainUrns: string[] = [];
    const derivedFromByUrn = new Map<string, string[]>();
    const visited = new Set<string>();
    let current: string | null = start.urn;
    while (current && !visited.has(current) && chainUrns.length < 50) {
      visited.add(current);
      chainUrns.push(current);
      const derivationEdges = await this.deps.graph.listEdgesFrom(current, 'prov:wasDerivedFrom');
      const targets = derivationEdges.map((edge) => edge.to_urn);
      derivedFromByUrn.set(current, targets);
      current = targets[0] ?? null;
    }

    // For every snapshot in the chain, reconstruct the activities that
    // generated it, the entities those activities used, and the agents
    // they were associated with.
    const derivation_chain = [];
    const replay: Array<{
      occurred_at?: string;
      operation: string;
      actor?: string;
      version_urn: string;
      status: string;
    }> = [];
    for (const versionUrn of chainUrns) {
      const targetingEdges = await this.deps.graph.listEdgesTo(versionUrn, 'sg:targets');
      const activities = [];
      for (const edge of targetingEdges) {
        const taskNode = await this.deps.graph.getNode(edge.from_urn);
        if (!taskNode || taskNode.entity_type !== 'TASK') continue;
        const usedEdges = await this.deps.graph.listEdgesFrom(taskNode.urn, 'prov:used');
        const used = [];
        for (const usedEdge of usedEdges) {
          const usedNode = await this.deps.graph.getNode(usedEdge.to_urn);
          used.push({
            urn: usedEdge.to_urn,
            ...(usedNode ? { entity_type: usedNode.entity_type as string } : {}),
          });
        }
        const agentEdges = await this.deps.graph.listEdgesFrom(taskNode.urn, 'prov:wasAssociatedWith');
        const associated_agents = [];
        for (const agentEdge of agentEdges) {
          const agentNode = await this.deps.graph.getNode(agentEdge.to_urn);
          associated_agents.push({
            urn: agentEdge.to_urn,
            ...(agentNode && stringOrUndefined(agentNode.properties['agent_name'])
              ? { agent_name: String(agentNode.properties['agent_name']) }
              : {}),
            ...(stringOrUndefined(agentEdge.properties['role']) ? { role: String(agentEdge.properties['role']) } : {}),
          });
        }
        const operation = stringOrUndefined(taskNode.properties['operation']) ?? 'unknown';
        const status = stringOrUndefined(taskNode.properties['status']) ?? 'completed';
        const occurredAt = stringOrUndefined(taskNode.properties['occurred_at']);
        const actor = stringOrUndefined(taskNode.properties['author']);
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
      activities.sort((left, right) => (left.occurred_at ?? '').localeCompare(right.occurred_at ?? ''));
      derivation_chain.push({
        version_urn: versionUrn,
        was_derived_from: derivedFromByUrn.get(versionUrn) ?? [],
        activities,
      });
    }
    replay.sort((left, right) => (left.occurred_at ?? '').localeCompare(right.occurred_at ?? ''));

    // Canonical provenance export: PROV-O projection -> RDFC-1.0 canonical
    // N-Quads -> content-addressed artifact. Idempotent by construction
    // (same graph shape/content => same digest => same bytes); detached
    // provenance signatures bind to that digest.
    const export_ = await canonicalizeProvenance({ entity: { urn: start.urn, entity_type: start.entity_type }, derivation_chain, replay });
    await this.deps.cas.put({
      bytes: Buffer.from(export_.nquads, 'utf8'),
      media_type: 'application/n-quads',
      original_path: `provenance/${sanitizePathSegment(start.urn)}.nq`,
    });

    const provenance_signatures = await this.buildProvenanceSignatureChecks(start.urn, export_.sha256);
    const all_provenance_signatures_verified =
      provenance_signatures.length > 0 && provenance_signatures.every((check) => check.verdict !== 'invalid');
    const current_provenance_signed = provenance_signatures.some((check) => check.verdict === 'valid');

    return {
      entity: { urn: start.urn, entity_type: start.entity_type },
      derivation_chain,
      replay,
      evidence: {
        canonical_rdf_sha256: export_.sha256,
        canonical_rdf_artifact_urn: artifactUrn(export_.sha256),
      },
      provenance_signatures,
      all_provenance_signatures_verified,
      current_provenance_signed,
    };
  }

  /**
   * Re-verify every stored provenance signature on read: fetch the signed
   * export from the CAS, resolve the trusted key, check the crypto, and
   * classify against the current digest. `stale` marks signatures made over
   * an earlier, still-retrievable export (provenance legitimately grows);
   * `invalid` covers missing artifacts, unresolvable/revoked keys, and bad
   * crypto.
   */
  private async buildProvenanceSignatureChecks(
    publicationUrn: string,
    currentSha256: string,
  ): Promise<import('../ports/registry-service.js').RegistryProvenanceSignatureVerification[]> {
    const edges = await this.deps.graph.listEdgesFrom(publicationUrn, 'sg:hasProvenanceSignature');
    const checks: import('../ports/registry-service.js').RegistryProvenanceSignatureVerification[] = [];
    for (const edge of edges) {
      const node = await this.deps.graph.getNode(edge.to_urn);
      if (!node || node.entity_type !== 'ARTIFACT') continue;
      const signer = stringOrUndefined(node.properties['signer']);
      const key_ref = stringOrUndefined(node.properties['key_ref']);
      const algorithm = stringOrUndefined(node.properties['algorithm']);
      const signed_at = stringOrUndefined(node.properties['signed_at']);
      const provenance_sha256 = stringOrUndefined(node.properties['provenance_sha256']);
      const signature = stringOrUndefined(node.properties['signature']);
      if (!signer || !key_ref || !algorithm || !signed_at || !provenance_sha256 || !signature) continue;

      let signedBytes: Buffer | null = null;
      try {
        const signedArtifact = await this.readCasArtifact(provenance_sha256);
        signedBytes = signedArtifact ? Buffer.from(signedArtifact.bytes) : null;
      } catch {
        signedBytes = null; // integrity mismatch reads as a missing artifact
      }
      const resolvedKey = await this.resolveTrustedPublicKeyMaterial(key_ref);
      const cryptographic_verification_passed =
        signedBytes !== null && resolvedKey
          ? verifyDetachedSignatureBytes({
              algorithm,
              public_key_pem: resolvedKey.public_key_pem,
              message: signedBytes.toString('utf8'),
              signature,
            })
          : false;
      const digest_matches_current = provenance_sha256 === currentSha256;
      const verdict: 'valid' | 'invalid' | 'stale' =
        signedBytes === null || !resolvedKey || !cryptographic_verification_passed
          ? 'invalid'
          : digest_matches_current
            ? 'valid'
            : 'stale';
      checks.push({
        artifact_urn: node.urn,
        signer,
        key_ref,
        algorithm,
        signed_at,
        provenance_sha256,
        artifact_present: signedBytes !== null,
        trusted_public_key_resolved: Boolean(resolvedKey),
        cryptographic_verification_passed,
        digest_matches_current,
        verdict,
      });
    }
    checks.sort(
      (left, right) =>
        left.key_ref.localeCompare(right.key_ref) ||
        left.signed_at.localeCompare(right.signed_at) ||
        left.artifact_urn.localeCompare(right.artifact_urn),
    );
    return checks;
  }

  private async getDetachedSignatures(publicationUrn: string): Promise<RegistryDetachedSignatureRecord[]> {
    const signatureEdges = await this.deps.graph.listEdgesFrom(publicationUrn, 'sg:hasDetachedSignature');
    const records: RegistryDetachedSignatureRecord[] = [];
    for (const edge of signatureEdges) {
      const node = await this.deps.graph.getNode(edge.to_urn);
      if (!node || node.entity_type !== 'ARTIFACT') continue;
      const signer = stringOrUndefined(node.properties['signer']);
      const key_ref = stringOrUndefined(node.properties['key_ref']);
      const algorithm = stringOrUndefined(node.properties['algorithm']);
      const signed_at = stringOrUndefined(node.properties['signed_at']);
      const envelope_sha256 = stringOrUndefined(node.properties['envelope_sha256']);
      const signature = stringOrUndefined(node.properties['signature']);
      if (!signer || !key_ref || !algorithm || !signed_at || !envelope_sha256 || !signature) continue;
      records.push({
        artifact_urn: node.urn,
        ...(toOptionalStringProp('sha256', parseArtifactSha256(node.urn))),
        signer,
        key_ref,
        algorithm,
        signed_at,
        envelope_sha256,
        signature,
        ...(node.properties['signed_payload'] === 'canonical_rdf' ? { signed_payload: 'canonical_rdf' as const } : {}),
        ...(stringOrUndefined(node.properties['transparency_log_ref'])
          ? { transparency_log_ref: String(node.properties['transparency_log_ref']) }
          : {}),
        ...(stringOrUndefined(node.properties['inclusion_proof_ref'])
          ? { inclusion_proof_ref: String(node.properties['inclusion_proof_ref']) }
          : {}),
        ...(node.properties['keyless'] === true &&
        stringOrUndefined(node.properties['keyless_identity']) &&
        stringOrUndefined(node.properties['keyless_issuer'])
          ? {
              keyless: {
                identity: String(node.properties['keyless_identity']),
                issuer: String(node.properties['keyless_issuer']),
              },
            }
          : {}),
      });
    }
    return records.sort((left, right) => left.signed_at.localeCompare(right.signed_at));
  }

  private async buildPublicationVerification(
    envelope: import('../ports/registry-service.js').RegistryPublicationEnvelope,
    liveEnvelope?: import('../ports/registry-service.js').RegistryPublicationEnvelope,
  ): Promise<RegistryPublicationVerification> {
    const recalculated = sha256Hex(Buffer.from(envelope.canonical_json, 'utf8'));
    const canonical_json_sha256_matches = recalculated === envelope.canonical_json_sha256;

    // Frozen publication envelope checks: confirm the recorded artifact still
    // hashes to its recorded digest, and whether the live graph derives the
    // same published bytes (evidence attached after publish changes them by
    // design).
    const envelopeArtifactUrn = envelope.publication_envelope_artifact_urn;
    const publication_envelope_artifact_present = Boolean(envelopeArtifactUrn);
    let publication_envelope_artifact_sha256_matches: boolean | null = null;
    if (envelopeArtifactUrn) {
      const recordedSha256 = envelope.publication_envelope_sha256 ?? parseArtifactSha256(envelopeArtifactUrn) ?? '';
      let got: Awaited<ReturnType<ArtifactStore['getBySha256']>> = null;
      try {
        got = recordedSha256 ? await this.deps.cas.getBySha256(recordedSha256) : null;
      } catch (err) {
        if (!(err instanceof CasIntegrityError)) throw err;
        // The store refused the read on an integrity mismatch: report it
        // rather than failing the whole verification request.
      }
      publication_envelope_artifact_sha256_matches =
        Boolean(recordedSha256) && got !== null && got.computed_sha256 === recordedSha256;
    }
    const live_envelope_matches_frozen_artifact =
      envelopeArtifactUrn && liveEnvelope
        ? sha256Hex(Buffer.from(liveEnvelope.canonical_json, 'utf8')) === envelope.canonical_json_sha256
        : null;

    // DSSE/in-toto attestations attached as evidence (build provenance,
    // SBOMs, scan results). Only verified evidence is ever stored, so the
    // aggregate is normally true; the flag surfaces any legacy anomaly.
    const attestationList =
      (await this.listAttestations({ publication_urn: envelope.publication_urn }))?.attestations ?? [];
    const all_attestation_signatures_valid = attestationList.every(
      (attestation) => attestation.signature_valid,
    );

    // Semantic digest: re-project the current publication graph to
    // canonical RDF (RDFC-1.0) and compare with the digest recorded at
    // publish time. Post-publish mutation of the graph is detected here,
    // mirroring the operational JSON digest check.
    let recomputedRdf: { nquads: string; sha256: string } | null = null;
    if (envelope.canonical_rdf_sha256 || envelope.detached_signatures.some((s) => s.signed_payload === 'canonical_rdf')) {
      const versionNode = await this.deps.graph.getNode(envelope.publication_urn);
      if (versionNode) {
        const edges = (await this.deps.graph.listEdgesFrom(versionNode.urn)).filter(
          (edge) =>
            edge.predicate !== 'sg:hasCanonicalRdf' &&
            edge.predicate !== 'prov:wasGeneratedBy' &&
            edge.predicate !== 'sg:hasDetachedSignature' &&
            edge.predicate !== 'sg:hasPublicationEnvelope',
        );
        const properties = omitProperties(versionNode.properties, PUBLICATION_PROJECTION_PROP_KEYS);
        const lines = projectPublicationGraphToNQuads({
          publication_urn: versionNode.urn,
          logical_urn: envelope.logical_urn,
          properties,
          edges: edges.map((edge) => ({ predicate: edge.predicate, to_urn: edge.to_urn })),
        });
        recomputedRdf = await computeCanonicalRdf(lines);
      }
    }
    const canonical_rdf_sha256_matches = envelope.canonical_rdf_sha256
      ? recomputedRdf?.sha256 === envelope.canonical_rdf_sha256
      : null;

    const signature_checks = await Promise.all(
      envelope.detached_signatures.map(async (signature) => {
        const signedPayload = signature.signed_payload ?? 'canonical_json';
        const expectedDigest = signedPayload === 'canonical_rdf' ? recomputedRdf?.sha256 : envelope.canonical_json_sha256;
        const signedBytes = signedPayload === 'canonical_rdf' ? recomputedRdf?.nquads : envelope.canonical_json;
        const envelope_sha256_matches = expectedDigest !== undefined && signature.envelope_sha256 === expectedDigest;
        if (signature.keyless) {
          const document = await this.loadSignatureDocument(signature.artifact_urn);
          const keylessSection =
            document && typeof document['keyless'] === 'object'
              ? (document['keyless'] as Record<string, unknown>)
              : undefined;
          // Fulcio certificates live ~10 minutes: validity must be anchored
          // at the registry-witnessed attach time (when the swap to the
          // chain was fully verified), not at audit time.
          const parsedSignedAt = Date.parse(signature.signed_at);
          const validityAnchor = Number.isNaN(parsedSignedAt) ? new Date() : new Date(parsedSignedAt);
          const keylessOutcome = verifyKeylessBundle({
            bundle: keylessSection?.['bundle'],
            signed_bytes: signedBytes === undefined ? undefined : Buffer.from(signedBytes, 'utf8'),
            policy: this.deps.keyless ?? null,
            at: validityAnchor,
          });
          const cryptographic_verification_passed = envelope_sha256_matches && keylessOutcome.verified;
          const failureStatus:
            | 'keyless_not_configured'
            | 'untrusted_certificate'
            | 'expired_certificate'
            | 'identity_policy_failed'
            | 'signature_mismatch'
            | 'cryptographic_failure'
            | 'tlog_inclusion_promise_failed'
            | 'tlog_not_configured' =
            keylessOutcome.failure_kind === 'not_configured'
              ? 'keyless_not_configured'
              : keylessOutcome.failure_kind === 'untrusted_certificate'
                ? 'untrusted_certificate'
                : keylessOutcome.failure_kind === 'expired_certificate'
                  ? 'expired_certificate'
                  : keylessOutcome.failure_kind === 'identity_policy_failed'
                    ? 'identity_policy_failed'
                    : keylessOutcome.failure_kind === 'tlog_inclusion_promise_failed'
                      ? 'tlog_inclusion_promise_failed'
                      : keylessOutcome.failure_kind === 'tlog_not_configured'
                        ? 'tlog_not_configured'
                        : keylessOutcome.failure_kind === 'digest_mismatch'
                          ? 'signature_mismatch'
                          : 'cryptographic_failure';
          return {
            artifact_urn: signature.artifact_urn,
            key_ref: signature.key_ref,
            signature_algorithm: signature.algorithm,
            signed_payload: signedPayload,
            signature_kind: 'keyless' as const,
            envelope_sha256_matches,
            trusted_public_key_resolved: false,
            cryptographic_verification_passed,
            keyless: {
              identity: keylessOutcome.identity ?? signature.keyless.identity,
              issuer: keylessOutcome.issuer ?? signature.keyless.issuer,
              verified: keylessOutcome.verified,
              validity_evaluated_at: keylessOutcome.validity_evaluated_at ?? validityAnchor.toISOString(),
              ...(keylessOutcome.failure_kind ? { failure_kind: keylessOutcome.failure_kind } : {}),
              ...(keylessOutcome.error ? { error: keylessOutcome.error } : {}),
              ...(keylessOutcome.certificate_chain_pem
                ? { certificate_chain_pem: keylessOutcome.certificate_chain_pem }
                : {}),
              ...(keylessOutcome.tlog ? { tlog: keylessOutcome.tlog } : {}),
            },
            inclusion_proof_present: Boolean(signature.inclusion_proof_ref),
            ...(await this.verifyTransparencyProof({
              signature,
              envelope_sha256: envelope.canonical_json_sha256,
            })),
            verification_status: !envelope_sha256_matches
              ? 'signature_mismatch'
              : keylessOutcome.verified
                ? 'verified'
                : failureStatus,
          } satisfies import('../ports/registry-service.js').RegistryDetachedSignatureVerification;
        }
        const resolvedKey = await this.resolveTrustedPublicKeyMaterial(signature.key_ref);
        const cryptographic_verification_passed =
          envelope_sha256_matches && resolvedKey && signedBytes !== undefined
            ? verifyDetachedSignatureBytes({
                algorithm: signature.algorithm,
                public_key_pem: resolvedKey.public_key_pem,
                message: signedBytes,
                signature: signature.signature,
              })
            : false;
        return {
          artifact_urn: signature.artifact_urn,
          key_ref: signature.key_ref,
          signature_algorithm: signature.algorithm,
          signed_payload: signedPayload,
          signature_kind: 'trusted_key' as const,
          envelope_sha256_matches,
          trusted_public_key_resolved: Boolean(resolvedKey),
          ...(resolvedKey ? { trusted_public_key_urn: resolvedKey.key_urn } : {}),
          cryptographic_verification_passed,
          ...(signature.transparency_log_ref ? { transparency_log_ref: signature.transparency_log_ref } : {}),
          ...(signature.inclusion_proof_ref ? { inclusion_proof_ref: signature.inclusion_proof_ref } : {}),
          inclusion_proof_present: Boolean(signature.inclusion_proof_ref),
          ...(
            await this.verifyTransparencyProof({
              signature,
              envelope_sha256: envelope.canonical_json_sha256,
            })
          ),
          verification_status: !envelope_sha256_matches
            ? 'signature_mismatch'
            : !resolvedKey
              ? 'missing_trusted_key'
              : !cryptographic_verification_passed
                ? 'cryptographic_failure'
                : 'verified',
        } satisfies import('../ports/registry-service.js').RegistryDetachedSignatureVerification;
      }),
    );
    const all_detached_signatures_match_envelope = signature_checks.every((check) => check.envelope_sha256_matches);
    const all_detached_signatures_resolve_trusted_key = signature_checks.every((check) => check.trusted_public_key_resolved);
    const all_detached_signatures_verify_cryptographically = signature_checks.every(
      (check) => check.cryptographic_verification_passed,
    );
    const all_detached_signatures_verified = signature_checks.every(
      (check) => check.verification_status === 'verified',
    );
    const all_detached_signatures_have_inclusion_proof = signature_checks.every((check) => check.inclusion_proof_present);
    const all_detached_signatures_validate_transparency_proof = signature_checks.every(
      (check) => check.transparency_verification_status === 'verified',
    );
    const transparencyStatuses = new Set(signature_checks.map((check) => check.transparency_verification_status));
    const publicationAppendIntent = envelope.transparency_append_intent
      ? buildAppendIntentVerification(envelope.transparency_append_intent)
      : undefined;
    const governanceAppendIntents = envelope.governance_artifacts
      .flatMap((artifact) => (artifact.transparency_append_intent ? [buildAppendIntentVerification(artifact.transparency_append_intent)] : []));
    const appendIntentStatuses = new Set(
      [
        ...(publicationAppendIntent ? [publicationAppendIntent.verification_status] : []),
        ...governanceAppendIntents.map((item) => item.verification_status),
      ],
    );
    return {
      envelope,
      canonical_json_sha256_matches,
      canonical_rdf_sha256_matches,
      publication_envelope_artifact_present,
      publication_envelope_artifact_sha256_matches,
      live_envelope_matches_frozen_artifact,
      attestations: attestationList,
      all_attestation_signatures_valid,
      all_detached_signatures_match_envelope,
      all_detached_signatures_resolve_trusted_key,
      all_detached_signatures_verify_cryptographically,
      all_detached_signatures_verified,
      all_detached_signatures_have_inclusion_proof,
      all_detached_signatures_validate_transparency_proof,
      signature_checks,
      ...(publicationAppendIntent ? { publication_append_intent: publicationAppendIntent } : {}),
      governance_append_intents: governanceAppendIntents,
      append_intent_verification_status:
        appendIntentStatuses.size === 0
          ? 'not_configured'
          : appendIntentStatuses.size === 1 && appendIntentStatuses.has('committed')
            ? 'committed'
            : appendIntentStatuses.has('submission_failed')
              ? appendIntentStatuses.has('committed') || appendIntentStatuses.has('staged_only')
                ? 'partial'
                : 'submission_failed'
              : appendIntentStatuses.has('staged_only')
                ? appendIntentStatuses.has('committed')
                  ? 'partial'
                  : 'staged_only'
                : 'partial',
      transparency_verification_status: transparencyStatuses.has('mismatch')
        ? 'mismatch'
        : transparencyStatuses.has('invalid')
          ? 'invalid'
          : transparencyStatuses.has('reference_only')
            ? 'reference_only'
            : transparencyStatuses.has('missing')
              ? 'missing'
              : 'verified',
      verification_status: !canonical_json_sha256_matches
        ? 'digest_mismatch'
        : !all_detached_signatures_match_envelope
          ? 'signature_mismatch'
          : signature_checks.every((check) => check.verification_status === 'verified')
            ? 'verified'
            : (signature_checks.find((check) => check.verification_status !== 'verified')?.verification_status ??
              'cryptographic_failure'),
    };
  }

  private async resolveTrustedPublicKeyMaterial(keyRef: string): Promise<{
    key_urn: string;
    algorithm: string;
    public_key_pem: string;
  } | null> {
    const trustedKey = await this.getTrustedPublicKey({ key_ref: keyRef });
    if (!trustedKey) return null;
    if (stringOrUndefined(trustedKey.public_key.properties['trust_status']) !== 'trusted') return null;
    if (!isWithinTrustWindow(trustedKey.public_key.properties, nowIso())) return null;
    const artifactUrnValue = trustedKey.artifacts[0]?.artifact_urn;
    if (!artifactUrnValue) return null;
    const artifact = await this.getArtifact({ artifact_urn: artifactUrnValue });
    if (!artifact) return null;
    return {
      key_urn: trustedKey.public_key.urn,
      algorithm: String(trustedKey.public_key.properties['algorithm'] ?? 'unknown'),
      public_key_pem: artifact.content,
    };
  }

  private async getTransparencyCheckpointDetails(
    checkpointArtifactUrn: string,
    input?: {
      witness_quorum_required?: number;
    },
  ): Promise<import('../ports/registry-service.js').RegistryTransparencyCheckpointDetails | null> {
    const artifactNode = await this.deps.graph.getNode(checkpointArtifactUrn);
    if (!artifactNode || artifactNode.entity_type !== 'ARTIFACT') return null;
    const body = stringOrUndefined(artifactNode.properties['checkpoint_body']);
    const signature = stringOrUndefined(artifactNode.properties['checkpoint_signature']);
    const rootHash = stringOrUndefined(artifactNode.properties['root_hash']);
    const treeSize = numberOrUndefined(artifactNode.properties['tree_size']);
    if (!body || !signature || !rootHash || typeof treeSize !== 'number') return null;
    const signedNote = stringOrUndefined(artifactNode.properties['signed_note']);
    const fallbackSignedNote = signedNote ? parseSignedCheckpointNote(signedNote) : null;
    const signatures =
      parseTransparencyNoteSignatures(artifactNode.properties['signed_note_signatures_json']) ??
      fallbackSignedNote?.signatures ??
      [buildNormalizedCheckpointSignature(signature)];
    const signatureCount = numberOrUndefined(artifactNode.properties['signed_note_signature_count']) ?? signatures.length;
    const noteFormat = parseTransparencyNoteFormat(artifactNode.properties['note_format']) ?? (signedNote ? 'raw_signed_note' : 'normalized_checkpoint');
    const signedNoteSigner =
      stringOrUndefined(artifactNode.properties['signed_note_signer']) ?? fallbackSignedNote?.signed_note_signer;
    const signedNoteKeyHint =
      stringOrUndefined(artifactNode.properties['signed_note_key_hint']) ?? fallbackSignedNote?.signed_note_key_hint;
    const appendOnlyVerified = booleanOrUndefined(artifactNode.properties['append_only_verified']);
    const witnessAttestations = await this.deps.graph.listEdgesFrom(checkpointArtifactUrn, 'sg:hasWitnessAttestation');
    const validWitnessCount = (
      await Promise.all(
        witnessAttestations.map(async (edge) => {
          const att = await this.deps.graph.getNode(edge.to_urn);
          return att && att.entity_type === 'ARTIFACT' && att.properties['signature_valid'] === true;
        }),
      )
    ).filter(Boolean).length;
    const witnessQuorumRequired = input?.witness_quorum_required ?? 0;
    return {
      checkpoint_artifact_urn: checkpointArtifactUrn,
      ...(toOptionalStringProp('sha256', parseArtifactSha256(checkpointArtifactUrn))),
      tree_size: treeSize,
      root_hash: rootHash,
      checkpoint_body: body,
      checkpoint_signature: signature,
      checkpoint_signature_valid: artifactNode.properties['checkpoint_signature_valid'] === true,
      ...(typeof appendOnlyVerified === 'boolean' ? { append_only_verified: appendOnlyVerified } : {}),
      ...(typeof input?.witness_quorum_required === 'number'
        ? { witness_quorum_satisfied: validWitnessCount >= witnessQuorumRequired }
        : {}),
      ...(typeof input?.witness_quorum_required === 'number'
        ? { witness_quorum_required: witnessQuorumRequired }
        : {}),
      valid_witness_attestation_count: validWitnessCount,
      note_format: noteFormat,
      signature_count: signatureCount,
      signatures,
      ...(signedNote ? { signed_note: signedNote } : {}),
      ...(signedNoteSigner ? { signed_note_signer: signedNoteSigner } : {}),
      ...(signedNoteKeyHint ? { signed_note_key_hint: signedNoteKeyHint } : {}),
    };
  }

  private async verifyWitnesses(input: {
    log: import('../ports/registry-service.js').RegistryTransparencyLogDetails;
    checkpoint_artifact_urn: string;
    checkpoint_body: string;
  }) {
    const witnessEdges = await this.deps.graph.listEdgesFrom(input.log.transparency_log.urn, 'sg:trustedByWitness');
    const attestationEdges = await this.deps.graph.listEdgesFrom(input.checkpoint_artifact_urn, 'sg:hasWitnessAttestation');
    const attestationNodes = await Promise.all(attestationEdges.map((edge) => this.deps.graph.getNode(edge.to_urn)));
    return await Promise.all(
      witnessEdges.map(async (edge) => {
        const witness = await this.deps.graph.getNode(edge.to_urn);
        if (!witness || witness.entity_type !== 'TRANSPARENCY_WITNESS') {
          return {
            witness_id: edge.to_urn,
            trusted_witness_resolved: false,
            trusted_key_resolved: false,
            signature_valid: false,
            verification_status: 'missing_witness' as const,
          };
        }
        if (stringOrUndefined(witness.properties['trust_status']) !== 'trusted' || !isWithinTrustWindow(witness.properties, nowIso())) {
          return {
            witness_id: String(witness.properties['witness_id'] ?? witness.urn),
            trusted_witness_resolved: false,
            trusted_key_resolved: false,
            signature_valid: false,
            verification_status: 'missing_witness' as const,
          };
        }
        const keyRef = stringOrUndefined(witness.properties['key_ref']);
        const key = keyRef ? await this.resolveTrustedPublicKeyMaterial(keyRef) : null;
        const attestationNode = attestationNodes.find(
          (node) => node && node.entity_type === 'ARTIFACT' && node.properties['witness_id'] === witness.properties['witness_id'],
        );
        const signature = attestationNode ? stringOrUndefined(attestationNode.properties['signature']) : undefined;
        const signatureValid =
          key &&
          signature &&
          verifyDetachedSignatureBytes({
            algorithm: key.algorithm,
            public_key_pem: key.public_key_pem,
            message: input.checkpoint_body,
            signature,
          });
        return {
          witness_id: String(witness.properties['witness_id'] ?? witness.urn),
          trusted_witness_resolved: true,
          trusted_key_resolved: Boolean(key),
          signature_valid: Boolean(signatureValid),
          verification_status: !key
            ? ('missing_key' as const)
            : !signatureValid
              ? ('cryptographic_failure' as const)
              : ('verified' as const),
        };
      }),
    );
  }

  private async listTransparencyCheckpointObservations(logUrn: string) {
    const edges = await this.deps.graph.listEdgesFrom(logUrn, 'sg:observedCheckpoint');
    const observations = await Promise.all(
      edges.map(async (edge) => {
        const node = await this.deps.graph.getNode(edge.to_urn);
        if (!node || node.entity_type !== 'ARTIFACT') return null;
        const checkpointArtifactUrn = stringOrUndefined(node.properties['checkpoint_artifact_urn']);
        const observedFromType = stringOrUndefined(node.properties['observed_from_type']);
        const observedFromId = stringOrUndefined(node.properties['observed_from_id']);
        const observedAt = stringOrUndefined(node.properties['observed_at']);
        if (
          !checkpointArtifactUrn ||
          !observedFromType ||
          !observedFromId ||
          !observedAt ||
          (observedFromType !== 'log' &&
            observedFromType !== 'witness' &&
            observedFromType !== 'distributor' &&
            observedFromType !== 'peer')
        ) {
          return null;
        }
        const checkpoint = await this.getTransparencyCheckpointDetails(checkpointArtifactUrn);
        if (!checkpoint) return null;
        const fallbackPayloadProvenance = buildCheckpointPayloadProvenance({
          checkpoint_body: checkpoint.checkpoint_body,
          checkpoint_signature: checkpoint.checkpoint_signature,
          signed_note: checkpoint.signed_note,
          note_format: checkpoint.note_format,
        });
        const noteFormat = parseTransparencyNoteFormat(node.properties['note_format']) ?? fallbackPayloadProvenance.note_format;
        const parseStrategy =
          parseTransparencyParseStrategy(node.properties['parse_strategy']) ?? fallbackPayloadProvenance.parse_strategy;
        const payloadSha256 = stringOrUndefined(node.properties['payload_sha256']) ?? fallbackPayloadProvenance.payload_sha256;
        const sourceChannel = stringOrUndefined(node.properties['source_channel']);
        const observerId = stringOrUndefined(node.properties['observer_id']);
        const observerType = stringOrUndefined(node.properties['observer_type']);
        const relayFromType = parseObservationPartyType(node.properties['relay_from_type']);
        const relayFromId = stringOrUndefined(node.properties['relay_from_id']);
        const relayHopCount = numberOrUndefined(node.properties['relay_hop_count']);
        const sourceCheckpointOccurredAt = stringOrUndefined(node.properties['source_checkpoint_occurred_at']);
        const observation: import('../ports/registry-service.js').RegistryTransparencyCheckpointObservation = {
          observation_artifact_urn: node.urn,
          observed_from_type: observedFromType,
          observed_from_id: observedFromId,
          observed_at: observedAt,
          checkpoint_artifact_urn: checkpointArtifactUrn,
          tree_size: checkpoint.tree_size,
          root_hash: checkpoint.root_hash,
          note_format: noteFormat,
          parse_strategy: parseStrategy,
          payload_sha256: payloadSha256,
          ...(sourceChannel ? { source_channel: sourceChannel } : {}),
          ...(observerId ? { observer_id: observerId } : {}),
          ...(observerType ? { observer_type: observerType } : {}),
          ...(relayFromType ? { relay_from_type: relayFromType } : {}),
          ...(relayFromId ? { relay_from_id: relayFromId } : {}),
          ...(typeof relayHopCount === 'number' ? { relay_hop_count: relayHopCount } : {}),
          ...(sourceCheckpointOccurredAt ? { source_checkpoint_occurred_at: sourceCheckpointOccurredAt } : {}),
        };
        return observation;
      }),
    );
    return observations.filter(
      (value): value is import('../ports/registry-service.js').RegistryTransparencyCheckpointObservation => value !== null,
    );
  }

  private async listTransparencyGossipEvents(logUrn: string) {
    const sentEdges = await this.deps.graph.listEdgesFrom(logUrn, 'sg:trustedByWitness');
    const witnessUrns = sentEdges.map((edge) => edge.to_urn);
    const events: import('../ports/registry-service.js').RegistryTransparencyGossipEvent[] = [];
    for (const witnessUrnValue of witnessUrns) {
      const gossipEdges = await this.deps.graph.listEdgesFrom(witnessUrnValue, 'sg:sentGossipEvent');
      for (const edge of gossipEdges) {
        const node = await this.deps.graph.getNode(edge.to_urn);
        if (!node || node.entity_type !== 'TRANSPARENCY_GOSSIP_EVENT') continue;
        const checkpointArtifactUrn = stringOrUndefined(node.properties['checkpoint_artifact_urn']);
        const fromWitnessId = stringOrUndefined(node.properties['from_witness_id']);
        const toWitnessId = stringOrUndefined(node.properties['to_witness_id']);
        const occurredAt = stringOrUndefined(node.properties['occurred_at']);
        const eventType = stringOrUndefined(node.properties['event_type']);
        if (!checkpointArtifactUrn || !fromWitnessId || !toWitnessId || !occurredAt || eventType !== 'checkpoint_gossip') continue;
        const checkpoint = await this.getTransparencyCheckpointDetails(checkpointArtifactUrn);
        const fallbackPayloadProvenance = checkpoint
          ? buildCheckpointPayloadProvenance({
              checkpoint_body: checkpoint.checkpoint_body,
              checkpoint_signature: checkpoint.checkpoint_signature,
              signed_note: checkpoint.signed_note,
              note_format: checkpoint.note_format,
            })
          : null;
        const noteFormat = parseTransparencyNoteFormat(node.properties['note_format']) ?? fallbackPayloadProvenance?.note_format;
        const parseStrategy =
          parseTransparencyParseStrategy(node.properties['parse_strategy']) ?? fallbackPayloadProvenance?.parse_strategy;
        const payloadSha256 = stringOrUndefined(node.properties['payload_sha256']) ?? fallbackPayloadProvenance?.payload_sha256;
        const sourceChannel = stringOrUndefined(node.properties['source_channel']);
        const relayedById = stringOrUndefined(node.properties['relayed_by_id']);
        const relayHopCount = numberOrUndefined(node.properties['relay_hop_count']);
        const sourceCheckpointOccurredAt =
          stringOrUndefined(node.properties['source_checkpoint_occurred_at']) ?? checkpoint?.occurred_at;
        const event: import('../ports/registry-service.js').RegistryTransparencyGossipEvent = {
          gossip_event_urn: node.urn,
          log_id: String(node.properties['log_id'] ?? ''),
          from_witness_id: fromWitnessId,
          to_witness_id: toWitnessId,
          checkpoint_artifact_urn: checkpointArtifactUrn,
          occurred_at: occurredAt,
          event_type: 'checkpoint_gossip',
          ...(noteFormat ? { note_format: noteFormat } : {}),
          ...(parseStrategy ? { parse_strategy: parseStrategy } : {}),
          ...(payloadSha256 ? { payload_sha256: payloadSha256 } : {}),
          ...(sourceChannel ? { source_channel: sourceChannel } : {}),
          ...(relayedById ? { relayed_by_id: relayedById } : {}),
          ...(typeof relayHopCount === 'number' ? { relay_hop_count: relayHopCount } : {}),
          ...(sourceCheckpointOccurredAt ? { source_checkpoint_occurred_at: sourceCheckpointOccurredAt } : {}),
        };
        events.push(event);
      }
    }
    return events.sort((left, right) => left.occurred_at.localeCompare(right.occurred_at));
  }

  private async listWitnessAttestations(checkpointArtifactUrns: string[]) {
    const values: Array<{
      attestation_artifact_urn: string;
      checkpoint_artifact_urn: string;
      witness_id: string;
      occurred_at: string;
    }> = [];
    for (const checkpointArtifactUrn of checkpointArtifactUrns) {
      const edges = await this.deps.graph.listEdgesFrom(checkpointArtifactUrn, 'sg:hasWitnessAttestation');
      for (const edge of edges) {
        const node = await this.deps.graph.getNode(edge.to_urn);
        if (!node || node.entity_type !== 'ARTIFACT') continue;
        const witnessId = stringOrUndefined(node.properties['witness_id']);
        if (!witnessId) continue;
        values.push({
          attestation_artifact_urn: node.urn,
          checkpoint_artifact_urn: checkpointArtifactUrn,
          witness_id: witnessId,
          occurred_at: stringOrUndefined(node.properties['observed_at']) ?? nowIso(),
        });
      }
    }
    return values;
  }

  private async verifyTransparencyProof(input: {
    signature: RegistryDetachedSignatureRecord;
    envelope_sha256: string;
  }): Promise<{
    trusted_transparency_log_resolved: boolean;
    transparency_log_urn?: string;
    checkpoint_key_ref?: string;
    checkpoint_key_resolved: boolean;
    checkpoint_signature_valid: boolean;
    transparency_proof_resolved: boolean;
    transparency_proof_validated: boolean;
    transparency_verification_status: 'verified' | 'missing' | 'reference_only' | 'mismatch' | 'invalid';
  }> {
    const ref = input.signature.inclusion_proof_ref;
    if (!ref) {
      return {
        trusted_transparency_log_resolved: false,
        checkpoint_key_resolved: false,
        checkpoint_signature_valid: false,
        transparency_proof_resolved: false,
        transparency_proof_validated: false,
        transparency_verification_status: 'missing',
      };
    }
    const artifact = await this.getArtifact({ artifact_urn: ref });
    if (!artifact) {
      return {
        trusted_transparency_log_resolved: false,
        checkpoint_key_resolved: false,
        checkpoint_signature_valid: false,
        transparency_proof_resolved: false,
        transparency_proof_validated: false,
        transparency_verification_status: 'reference_only',
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(artifact.content);
    } catch {
      return {
        trusted_transparency_log_resolved: false,
        checkpoint_key_resolved: false,
        checkpoint_signature_valid: false,
        transparency_proof_resolved: true,
        transparency_proof_validated: false,
        transparency_verification_status: 'invalid',
      };
    }
    if (!isTransparencyProofPayload(parsed)) {
      return {
        trusted_transparency_log_resolved: false,
        checkpoint_key_resolved: false,
        checkpoint_signature_valid: false,
        transparency_proof_resolved: true,
        transparency_proof_validated: false,
        transparency_verification_status: 'invalid',
      };
    }
    const transparencyLog = await this.getTransparencyLog({ log_id: parsed.log_id });
    const resolvedLog =
      transparencyLog &&
      stringOrUndefined(transparencyLog.transparency_log.properties['trust_status']) === 'trusted' &&
      isWithinTrustWindow(transparencyLog.transparency_log.properties, nowIso())
      ? transparencyLog
      : null;
    const checkpointKeyRef = resolvedLog
      ? stringOrUndefined(resolvedLog.transparency_log.properties['checkpoint_key_ref'])
      : undefined;
    const checkpointKey = checkpointKeyRef ? await this.resolveTrustedPublicKeyMaterial(checkpointKeyRef) : null;
    const checkpoint_signature_valid =
      checkpointKey &&
      verifyDetachedSignatureBytes({
        algorithm: checkpointKey.algorithm,
        public_key_pem: checkpointKey.public_key_pem,
        message: parsed.checkpoint_body,
        signature: parsed.checkpoint_signature,
      });
    const checkpointFields = parseCheckpointBody(parsed.checkpoint_body);
    const leafHash = rfc6962LeafHash(
      buildTransparencyLeafPayload({
        log_id: parsed.log_id,
        envelope_sha256: input.envelope_sha256,
        signer: input.signature.signer,
        key_ref: input.signature.key_ref,
        algorithm: input.signature.algorithm,
        signature: input.signature.signature,
      }),
    );
    const merkleRootMatches = verifyRfc6962InclusionProof({
      leaf_hash: leafHash,
      leaf_index: parsed.leaf_index,
      tree_size: parsed.tree_size,
      proof_hashes: parsed.proof_hashes,
      expected_root_hash: parsed.root_hash,
    });
    const matches =
      parsed.envelope_sha256 === input.envelope_sha256 &&
      parsed.signature_artifact_urn === input.signature.artifact_urn &&
      merkleRootMatches &&
      Boolean(checkpointFields) &&
      checkpointFields?.tree_size === parsed.tree_size &&
      checkpointFields?.root_hash === parsed.root_hash &&
      checkpointFields?.origin === stringOrUndefined(resolvedLog?.transparency_log.properties['origin']) &&
      Boolean(checkpoint_signature_valid) &&
      (!input.signature.transparency_log_ref ||
        !parsed.transparency_log_ref ||
        parsed.transparency_log_ref === input.signature.transparency_log_ref);
    return {
      trusted_transparency_log_resolved: Boolean(resolvedLog),
      ...(resolvedLog ? { transparency_log_urn: resolvedLog.transparency_log.urn } : {}),
      ...(checkpointKeyRef ? { checkpoint_key_ref: checkpointKeyRef } : {}),
      checkpoint_key_resolved: Boolean(checkpointKey),
      checkpoint_signature_valid: Boolean(checkpoint_signature_valid),
      transparency_proof_resolved: true,
      transparency_proof_validated: matches,
      transparency_verification_status: matches ? 'verified' : 'mismatch',
    };
  }

  // Pre-mutation signature validation for prepared publications: every
  // signature must validate against the pinned candidate BEFORE publish
  // touches the graph, so a bad signature cannot leave a published-but-
  // unsigned version behind.
  private async validatePreparedPublicationSignatures(input: {
    logical_key: string;
    candidate: PreparedPublicationRecord['candidate'];
    signatures: import('../ports/registry-service.js').RegistryDetachedSignatureInput[];
    errorPrefix: 'SKILL_VERSION' | 'AGENT_VERSION';
  }): Promise<void> {
    for (const signature of input.signatures) {
      const signedPayload = signature.signed_payload ?? 'canonical_json';
      const digest =
        signedPayload === 'canonical_rdf'
          ? input.candidate.canonical_rdf_sha256
          : input.candidate.canonical_json_sha256;
      const message =
        signedPayload === 'canonical_rdf'
          ? input.candidate.canonical_rdf_nquads
          : input.candidate.canonical_json;
      if (!digest || !message) {
        throw new RegistryCoreError(
          `${input.errorPrefix}_SIGNATURE_INVALID`,
          'The prepared publication does not provide the signed payload.',
        );
      }
      if (signature.keyless_bundle !== undefined) {
        const outcome = verifyKeylessBundle({
          bundle: signature.keyless_bundle,
          signed_bytes: Buffer.from(message, 'utf8'),
          policy: this.deps.keyless ?? null,
          at: new Date(),
          require_valid_at: new Date(),
        });
        if (!outcome.verified) {
          throw new RegistryCoreError(
            `${input.errorPrefix}_KEYLESS_SIGNATURE_INVALID`,
            `Keyless signature rejected: ${outcome.error ?? 'verification failed'}.`,
          );
        }
        continue;
      }
      if (!signature.key_ref || !signature.algorithm || !signature.signature) {
        throw new RegistryCoreError(
          `${input.errorPrefix}_SIGNATURE_INVALID`,
          'Signatures require key_ref, algorithm, and signature (or a keyless bundle).',
        );
      }
      const material = await this.resolveTrustedPublicKeyMaterial(signature.key_ref);
      if (!material) {
        throw new RegistryCoreError(
          `${input.errorPrefix}_SIGNATURE_INVALID`,
          `Signature key ${signature.key_ref} is not a trusted public key.`,
        );
      }
      const verified = verifyDetachedSignatureBytes({
        algorithm: signature.algorithm,
        public_key_pem: material.public_key_pem,
        message,
        signature: signature.signature,
      });
      if (!verified) {
        throw new RegistryCoreError(
          `${input.errorPrefix}_SIGNATURE_INVALID`,
          'Detached signature failed cryptographic verification over the prepared envelope.',
        );
      }
      await this.enforceTrustedPublisherOnSignature({
        properties: input.candidate.properties,
        keyRef: signature.key_ref,
        errorCode: `${input.errorPrefix}_SIGNATURE_PUBLISHER_MISMATCH`,
      });
    }
  }

  private async createKeylessDetachedSignature(input: {
    publication_urn: string;
    logical_key: string;
    signed_payload: 'canonical_json' | 'canonical_rdf';
    envelope_sha256: string;
    keyless_bundle: unknown;
    signed_bytes: Buffer;
    signer: string;
    errorPrefix: 'SKILL_VERSION' | 'AGENT_VERSION';
  }): Promise<RegistryDetachedSignatureRecord> {
    const outcome = verifyKeylessBundle({
      bundle: input.keyless_bundle,
      signed_bytes: input.signed_bytes,
      policy: this.deps.keyless ?? null,
      at: new Date(),
      require_valid_at: new Date(),
    });
    if (!outcome.verified || !outcome.identity || !outcome.issuer) {
      throw new RegistryCoreError(
        `${input.errorPrefix}_KEYLESS_SIGNATURE_INVALID`,
        `Keyless signature rejected: ${outcome.error ?? 'verification failed'}.`,
      );
    }
    const bundle = input.keyless_bundle as Record<string, unknown>;
    const messageSignature = (bundle['messageSignature'] as Record<string, unknown> | undefined) ?? {};
    const signatureValue =
      typeof messageSignature['signature'] === 'string' ? `base64:${messageSignature['signature']}` : 'keyless';
    return await this.createDetachedSignature({
      publication_urn: input.publication_urn,
      logical_key: input.logical_key,
      envelope_sha256: input.envelope_sha256,
      signer: input.signer,
      key_ref: outcome.identity,
      algorithm: outcome.algorithm ?? 'keyless',
      signature: signatureValue,
      signed_payload: input.signed_payload,
      keyless: {
        identity: outcome.identity,
        issuer: outcome.issuer,
        certificate_chain_pem: outcome.certificate_chain_pem ?? '',
        bundle: input.keyless_bundle,
      },
    });
  }

  private async createDetachedSignature(input: {
    publication_urn: string;
    logical_key: string;
    envelope_sha256: string;
    signer: string;
    key_ref: string;
    algorithm: string;
    signature: string;
    signed_payload?: 'canonical_json' | 'canonical_rdf';
    transparency_log_ref?: string;
    inclusion_proof_ref?: string;
    inclusion_proof?: import('../ports/registry-service.js').RegistryTransparencyInclusionProofInput;
    keyless?: {
      identity: string;
      issuer: string;
      certificate_chain_pem: string;
      bundle: unknown;
    };
  }): Promise<RegistryDetachedSignatureRecord> {
    const signed_at = nowIso();
    const signedPayload = input.signed_payload ?? 'canonical_json';
    const content = canonicalJsonString({
      publication_urn: input.publication_urn,
      signer: input.signer,
      key_ref: input.key_ref,
      algorithm: input.algorithm,
      signed_at,
      envelope_sha256: input.envelope_sha256,
      signature: input.signature,
      signed_payload: signedPayload,
      ...(input.transparency_log_ref ? { transparency_log_ref: input.transparency_log_ref } : {}),
      ...(input.inclusion_proof_ref ? { inclusion_proof_ref: input.inclusion_proof_ref } : {}),
      ...(input.keyless ? { keyless: input.keyless } : {}),
    });
    const artifact = await this.deps.cas.put({
      bytes: Buffer.from(content, 'utf8'),
      media_type: 'application/json',
      original_path: `generated/detached-signature/${sanitizePathSegment(input.logical_key)}.json`,
    });
    const artifactNodeUrn = artifactUrn(artifact.sha256);
    await this.deps.graph.upsertNode({
      urn: artifactNodeUrn,
      entity_type: 'ARTIFACT',
      properties: {
        sha256: artifact.sha256,
        size_bytes: artifact.size_bytes,
        media_type: artifact.media_type,
        original_path: artifact.original_path,
        governance_role: 'detached_signature',
        signer: input.signer,
        key_ref: input.key_ref,
        algorithm: input.algorithm,
        signed_at,
        envelope_sha256: input.envelope_sha256,
        signature: input.signature,
        signed_payload: signedPayload,
        ...(input.keyless
          ? { keyless: true, keyless_identity: input.keyless.identity, keyless_issuer: input.keyless.issuer }
          : {}),
        ...(input.transparency_log_ref ? { transparency_log_ref: input.transparency_log_ref } : {}),
        ...(input.inclusion_proof_ref ? { inclusion_proof_ref: input.inclusion_proof_ref } : {}),
      },
    });
    await this.deps.graph.upsertEdge({
      from_urn: input.publication_urn,
      to_urn: artifactNodeUrn,
      predicate: 'sg:hasDetachedSignature',
      properties: {},
    });
    let inclusionProofRef = input.inclusion_proof_ref;
    if (input.inclusion_proof) {
      const proofArtifactUrn = await this.createTransparencyInclusionProofArtifact({
        logical_key: input.logical_key,
        signature_artifact_urn: artifactNodeUrn,
        envelope_sha256: input.envelope_sha256,
        proof: input.inclusion_proof,
      });
      inclusionProofRef = proofArtifactUrn;
      await this.deps.graph.upsertNode({
        urn: artifactNodeUrn,
        entity_type: 'ARTIFACT',
        properties: {
          sha256: artifact.sha256,
          size_bytes: artifact.size_bytes,
          media_type: artifact.media_type,
          original_path: artifact.original_path,
          governance_role: 'detached_signature',
          signer: input.signer,
          key_ref: input.key_ref,
          algorithm: input.algorithm,
          signed_at,
          envelope_sha256: input.envelope_sha256,
          signature: input.signature,
          ...(input.keyless
            ? { keyless: true, keyless_identity: input.keyless.identity, keyless_issuer: input.keyless.issuer }
            : {}),
          ...(input.transparency_log_ref ? { transparency_log_ref: input.transparency_log_ref } : {}),
          inclusion_proof_ref: proofArtifactUrn,
        },
      });
      await this.deps.graph.upsertEdge({
        from_urn: artifactNodeUrn,
        to_urn: proofArtifactUrn,
        predicate: 'sg:hasInclusionProof',
        properties: {},
      });
    }
    return {
      artifact_urn: artifactNodeUrn,
      sha256: artifact.sha256,
      signer: input.signer,
      key_ref: input.key_ref,
      algorithm: input.algorithm,
      signed_at,
      envelope_sha256: input.envelope_sha256,
      signature: input.signature,
      ...(input.keyless ? { keyless: { identity: input.keyless.identity, issuer: input.keyless.issuer } } : {}),
      ...(input.transparency_log_ref ? { transparency_log_ref: input.transparency_log_ref } : {}),
      ...(inclusionProofRef ? { inclusion_proof_ref: inclusionProofRef } : {}),
    };
  }

  private async createTransparencyInclusionProofArtifact(input: {
    logical_key: string;
    signature_artifact_urn: string;
    envelope_sha256: string;
    proof: import('../ports/registry-service.js').RegistryTransparencyInclusionProofInput;
  }) {
    const content = canonicalJsonString({
      log_id: input.proof.log_id,
      tree_size: input.proof.tree_size,
      leaf_index: input.proof.leaf_index,
      root_hash: input.proof.root_hash,
      proof_hashes: input.proof.proof_hashes,
      checkpoint_body: input.proof.checkpoint_body,
      checkpoint_signature: input.proof.checkpoint_signature,
      ...(input.proof.transparency_log_ref ? { transparency_log_ref: input.proof.transparency_log_ref } : {}),
      envelope_sha256: input.envelope_sha256,
      signature_artifact_urn: input.signature_artifact_urn,
    });
    const artifact = await this.deps.cas.put({
      bytes: Buffer.from(content, 'utf8'),
      media_type: 'application/json',
      original_path: `generated/inclusion-proof/${sanitizePathSegment(input.logical_key)}.json`,
    });
    const artifactNodeUrn = artifactUrn(artifact.sha256);
    await this.deps.graph.upsertNode({
      urn: artifactNodeUrn,
      entity_type: 'ARTIFACT',
      properties: {
        sha256: artifact.sha256,
        size_bytes: artifact.size_bytes,
        media_type: artifact.media_type,
        original_path: artifact.original_path,
        governance_role: 'transparency_inclusion_proof',
        log_id: input.proof.log_id,
        tree_size: input.proof.tree_size,
        leaf_index: input.proof.leaf_index,
        root_hash: input.proof.root_hash,
        envelope_sha256: input.envelope_sha256,
        signature_artifact_urn: input.signature_artifact_urn,
        ...(input.proof.transparency_log_ref ? { transparency_log_ref: input.proof.transparency_log_ref } : {}),
      },
    });
    return artifactNodeUrn;
  }

  private async createGovernanceArtifact(input: {
    role: 'policy_package' | 'validation_report' | 'certification_evidence' | 'review_evidence' | 'review_evidence';
    logical_key: string;
    publication_urn: string;
    payload: Record<string, unknown>;
    // Prepared publications: `undefined` publishes a fresh transparency
    // intent (legacy behaviour), `null` skips intent stamping entirely, and a
    // ref stamps the pinned reservation instead of re-publishing it (which
    // would generate a different request id and diverge from the candidate).
    append_intent?: import('../ports/registry-service.js').RegistryTransparencyAppendIntentRef | null;
  }) {
    const content = canonicalJsonString({
      role: input.role,
      logical_key: input.logical_key,
      publication_urn: input.publication_urn,
      payload: input.payload,
    });
    const artifact = await this.deps.cas.put({
      bytes: Buffer.from(content, 'utf8'),
      media_type: 'application/json',
      original_path: `generated/${input.role}/${sanitizePathSegment(input.logical_key)}.json`,
    });
    const artifactNodeUrn = artifactUrn(artifact.sha256);
    await this.deps.graph.upsertNode({
      urn: artifactNodeUrn,
      entity_type: 'ARTIFACT',
      properties: {
        sha256: artifact.sha256,
        size_bytes: artifact.size_bytes,
        media_type: artifact.media_type,
        original_path: artifact.original_path,
        governance_role: input.role,
      },
    });
    if (input.append_intent === null) {
      return {
        role: input.role,
        artifact_urn: artifactNodeUrn,
        sha256: artifact.sha256,
      } as const;
    }
    if (input.append_intent) {
      const node = await this.deps.graph.getNode(artifactNodeUrn);
      if (node) {
        await this.deps.graph.upsertNode({
          urn: node.urn,
          entity_type: node.entity_type,
          properties: {
            ...node.properties,
            ...transparencyAppendIntentProps(input.append_intent),
          },
        });
      }
      return {
        role: input.role,
        artifact_urn: artifactNodeUrn,
        sha256: artifact.sha256,
      } as const;
    }
    await this.attachGovernanceArtifactAppendIntent({
      artifact_urn: artifactNodeUrn,
      role: input.role,
      logical_key: input.logical_key,
      publication_urn: input.publication_urn,
      sha256: artifact.sha256,
      payload: input.payload,
    });
    return {
      role: input.role,
      artifact_urn: artifactNodeUrn,
      sha256: artifact.sha256,
    } as const;
  }
}

function resolveAgentSourcePath(input: CreateAgentInput): string | undefined {
  return input.source_path ?? input.artifact?.original_path;
}

function resolveSkillSourcePath(input: CreateSkillInput): string | undefined {
  return input.source_path ?? input.artifact?.original_path;
}

function resolveSkillUrn(skillUrnValue?: string, skillKey?: string): string {
  if (skillUrnValue) return skillUrnValue;
  if (skillKey) return skillUrn(skillKey);
  throw new RegistryCoreError('SKILL_REFERENCE_INVALID', 'Skill reference must include skill_urn or skill_key.');
}

const ARTIFACT_SHA256_PATTERN = /^[0-9a-f]{64}$/;

function parseArtifactSha256(artifactUrnValue: string): string | undefined {
  const prefix = 'urn:sg:artifact:sha256:';
  if (!artifactUrnValue.startsWith(prefix)) return undefined;
  const sha256 = artifactUrnValue.slice(prefix.length);
  return ARTIFACT_SHA256_PATTERN.test(sha256) ? sha256 : undefined;
}

function parseHarnessName(harnessUrnValue: string): string | undefined {
  const prefix = 'urn:sg:harness:';
  return harnessUrnValue.startsWith(prefix) ? harnessUrnValue.slice(prefix.length) : undefined;
}

function parseSkillKey(skillUrnValue: string): string | undefined {
  const prefix = 'urn:sg:skill:';
  return skillUrnValue.startsWith(prefix) ? skillUrnValue.slice(prefix.length) : undefined;
}

function getVersionNumber(properties: Record<string, unknown>): number {
  const raw = properties['version'];
  return typeof raw === 'number' ? raw : 0;
}

function lifecycleStatus(properties: Record<string, unknown>): import('../ports/registry-service.js').RegistryLifecycleStatus {
  const raw = properties['lifecycle_status'];
  if (
    raw === 'draft' ||
    raw === 'validated' ||
    raw === 'rejected' ||
    raw === 'published' ||
    raw === 'certified' ||
    raw === 'deprecated' ||
    raw === 'revoked' ||
    raw === 'archived'
  ) {
    return raw;
  }
  return 'draft';
}

function decodeArtifactInput(content: string, encoding: 'utf8' | 'base64'): Uint8Array {
  return encoding === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8');
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function toOptionalStringProp<K extends string>(key: K, value: string | undefined): Record<K, string> | {} {
  return value ? { [key]: value } as Record<K, string> : {};
}

function dedupeArtifacts(
  values: Array<{
    artifact_urn: string;
    sha256?: string;
  }>,
) {
  const byUrn = new Map<string, { artifact_urn: string; sha256?: string }>();
  for (const value of values) {
    const existing = byUrn.get(value.artifact_urn);
    byUrn.set(value.artifact_urn, {
      artifact_urn: value.artifact_urn,
      ...(existing?.sha256 ? { sha256: existing.sha256 } : {}),
      ...(value.sha256 ? { sha256: value.sha256 } : {}),
    });
  }
  return [...byUrn.values()];
}

function dedupeSkillRefs(
  values: Array<{
    skill_urn: string;
    skill_key?: string;
  }>,
) {
  const byUrn = new Map<string, { skill_urn: string; skill_key?: string }>();
  for (const value of values) {
    const existing = byUrn.get(value.skill_urn);
    byUrn.set(value.skill_urn, {
      skill_urn: value.skill_urn,
      ...(existing?.skill_key ? { skill_key: existing.skill_key } : {}),
      ...(value.skill_key ? { skill_key: value.skill_key } : {}),
    });
  }
  return [...byUrn.values()];
}

function dedupeHarnessRefs(
  values: Array<{
    harness_urn: string;
    harness_name?: string;
  }>,
) {
  const byUrn = new Map<string, { harness_urn: string; harness_name?: string }>();
  for (const value of values) {
    const existing = byUrn.get(value.harness_urn);
    byUrn.set(value.harness_urn, {
      harness_urn: value.harness_urn,
      ...(existing?.harness_name ? { harness_name: existing.harness_name } : {}),
      ...(value.harness_name ? { harness_name: value.harness_name } : {}),
    });
  }
  return [...byUrn.values()];
}

function buildDefaultGovernanceArtifacts(input: {
  entity_type: 'AGENT_VERSION' | 'SKILL_VERSION';
  logical_key: string;
  publication_urn: string;
  actor: string;
  policy_version: string;
  validation_report: string;
}) {
  return [
    {
      role: 'policy_package' as const,
      payload: {
        entity_type: input.entity_type,
        logical_key: input.logical_key,
        publisher: input.actor,
        policy_version: input.policy_version,
      },
    },
    {
      role: 'validation_report' as const,
      payload: {
        entity_type: input.entity_type,
        logical_key: input.logical_key,
        validation_status: 'passed',
        validation_report: input.validation_report,
      },
    },
  ];
}

function governanceInputHints(governance: RegistryGovernanceInput | undefined, signatureRef: string | undefined) {
  return {
    ...(governance?.publisher ? { publisher: governance.publisher } : {}),
    ...(governance?.policy_version ? { policy_version: governance.policy_version } : {}),
    ...(governance?.ontology_version ? { ontology_version: governance.ontology_version } : {}),
    ...(governance?.validation_report ? { validation_report: governance.validation_report } : {}),
    ...(governance?.signature_ref ? { signature_ref: governance.signature_ref } : {}),
    ...(signatureRef && !governance?.signature_ref ? { signature_ref: signatureRef } : {}),
    ...(governance?.approver ? { approved_by: governance.approver } : {}),
    ...(governance?.approver_role ? { approved_role: governance.approver_role } : {}),
  };
}


function ensureAgentGovernanceReady(input: {
  version: RegistryAgentVersionDetails;
  actor: string;
  governance?: RegistryGovernanceInput;
  note?: string;
}) {
  const properties = input.version.agent_version.properties;
  const artifactSha = stringOrUndefined(properties['artifact_sha256']);
  const sourcePath = stringOrUndefined(properties['source_path']);
  if (!artifactSha) {
    throw new RegistryCoreError('AGENT_PUBLISH_EVIDENCE_INCOMPLETE', 'Agent version is missing artifact evidence.');
  }
  if (!sourcePath) {
    throw new RegistryCoreError('AGENT_PUBLISH_EVIDENCE_INCOMPLETE', 'Agent version is missing source path evidence.');
  }

  const publication = buildPublicationGovernance({
    entity_type: 'AGENT_VERSION',
    urn: input.version.agent_version.urn,
    current_properties: properties,
    actor: input.actor,
    ...(input.governance ? { governance: input.governance } : {}),
    publishedAt: nowIso(),
    ...(input.note ? { note: input.note } : {}),
  });
  return publication;
}

function ensureSkillGovernanceReady(input: {
  version: RegistrySkillVersionDetails;
  actor: string;
  governance?: RegistryGovernanceInput;
  note?: string;
}) {
  const properties = input.version.skill_version.properties;
  const artifactSha = stringOrUndefined(properties['artifact_sha256']);
  const sourcePath = stringOrUndefined(properties['source_path']);
  if (!artifactSha) {
    throw new RegistryCoreError('SKILL_PUBLISH_EVIDENCE_INCOMPLETE', 'Skill version is missing artifact evidence.');
  }
  if (!sourcePath) {
    throw new RegistryCoreError('SKILL_PUBLISH_EVIDENCE_INCOMPLETE', 'Skill version is missing source path evidence.');
  }

  const publication = buildPublicationGovernance({
    entity_type: 'SKILL_VERSION',
    urn: input.version.skill_version.urn,
    current_properties: properties,
    actor: input.actor,
    ...(input.governance ? { governance: input.governance } : {}),
    publishedAt: nowIso(),
    ...(input.note ? { note: input.note } : {}),
  });
  return publication;
}

function buildPublicationGovernance(input: {
  entity_type: 'SKILL_VERSION' | 'AGENT_VERSION';
  urn: string;
  current_properties: Record<string, unknown>;
  actor: string;
  governance?: RegistryGovernanceInput;
  publishedAt: string;
  note?: string;
}) {
  const publisher = input.governance?.publisher ?? input.actor;
  const policyVersion =
    input.governance?.policy_version ??
    stringOrUndefined(input.current_properties['policy_version']) ??
    'registry-policy/v1';
  const validationReport = input.governance?.validation_report ?? 'publish-gate:v1 passed';
  const signatureRef =
    input.governance?.signature_ref ??
    stringOrUndefined(input.current_properties['artifact_signature']);
  const approvedBy = input.governance?.approver;
  const approvedRole = input.governance?.approver_role;
  const canonicalJsonSha = sha256Hex(
    Buffer.from(
      canonicalJsonString({
        urn: input.urn,
        entity_type: input.entity_type,
        publisher,
        published_at: input.publishedAt,
        policy_version: policyVersion,
        validation_report: validationReport,
        ...(signatureRef ? { signature_ref: signatureRef } : {}),
        ...(approvedBy ? { approved_by: approvedBy } : {}),
        ...(approvedRole ? { approved_role: approvedRole } : {}),
        properties: input.current_properties,
        ...(input.note ? { note: input.note } : {}),
      }),
      'utf8',
    ),
  );

  return {
    properties: {
      publisher,
      published_at: input.publishedAt,
      publication_status: 'published',
      policy_version: policyVersion,
      validation_status: 'passed',
      validation_report: validationReport,
      canonical_json_sha256: canonicalJsonSha,
      canonicalization_algorithm: JCS_CANONICALIZATION_ALGORITHM,
      ...(signatureRef ? { signature_ref: signatureRef } : {}),
      ...(approvedBy ? { approved_by: approvedBy } : {}),
      ...(approvedRole ? { approved_role: approvedRole } : {}),
    },
    taskEvidence: {
      publisher,
      policy_version: policyVersion,
      validation_status: 'passed',
      validation_report: validationReport,
      canonical_json_sha256: canonicalJsonSha,
      ...(signatureRef ? { signature_ref: signatureRef } : {}),
      ...(approvedBy ? { approved_by: approvedBy } : {}),
      ...(approvedRole ? { approved_role: approvedRole } : {}),
    },
  };
}

function buildPublicationEnvelope(input: {
  publication_urn: string;
  logical_urn: string;
  entity_type: 'AGENT_VERSION' | 'SKILL_VERSION';
  properties: Record<string, unknown>;
  artifacts: Array<{ artifact_urn: string; sha256?: string }>;
  governance_artifacts: Array<{ role: 'policy_package' | 'validation_report' | 'certification_evidence' | 'review_evidence'; artifact_urn: string; sha256?: string }>;
  detached_signatures: RegistryDetachedSignatureRecord[];
  transparency_append_intent?: import('../ports/registry-service.js').RegistryTransparencyAppendIntentRef;
  // Frozen publication envelope bytes read from the CAS artifact recorded at
  // publish time. When present, these bytes are served as the canonical
  // payload so signatures stay stable while later evidence is attached.
  frozen_canonical_json?: string;
  frozen_canonical_json_sha256?: string;
}) {
  // Versions published before the JCS migration carry no
  // `canonicalization_algorithm` property; their envelopes must be
  // re-derived with the legacy serializer so existing signatures verify.
  const canonicalization_algorithm = resolveCanonicalizationAlgorithm(
    input.properties['canonicalization_algorithm'],
  );
  const derived_canonical_json = canonicalizeWith(canonicalization_algorithm, {
    publication_urn: input.publication_urn,
    logical_urn: input.logical_urn,
    entity_type: input.entity_type,
    properties: omitPublicationEnvelopeProps(input.properties),
    artifacts: input.artifacts,
    governance_artifacts: input.governance_artifacts,
  });
  const canonical_json = input.frozen_canonical_json ?? derived_canonical_json;
  const canonical_json_sha256 =
    input.frozen_canonical_json_sha256 ?? sha256Hex(Buffer.from(canonical_json, 'utf8'));
  const envelopeArtifactUrn = stringOrUndefined(input.properties['publication_envelope_artifact_urn']);
  const envelopeArtifactSha256 = stringOrUndefined(input.properties['publication_envelope_sha256']);
  const lineage = input.properties['lineage'];
  const provenance_refs =
    lineage && typeof lineage === 'object' && !Array.isArray(lineage)
      ? (lineage as {
          upstream_skill_version_urns?: string[];
          openlineage?: { job_namespace?: string; job_name?: string; run_id?: string; event_time?: string };
        })
      : undefined;
  const revokedAt = stringOrUndefined(input.properties['revoked_at']);
  const revokedBy = stringOrUndefined(input.properties['revoked_by']);
  const revocationReason = stringOrUndefined(input.properties['revocation_reason']);
  const supersededByVersionUrn = stringOrUndefined(input.properties['superseded_by_version_urn']);
  return {
    publication_urn: input.publication_urn,
    logical_urn: input.logical_urn,
    entity_type: input.entity_type,
    canonical_json,
    canonical_json_sha256,
    canonicalization_algorithm,
    ...(envelopeArtifactUrn ? { publication_envelope_artifact_urn: envelopeArtifactUrn } : {}),
    ...(envelopeArtifactSha256 ? { publication_envelope_sha256: envelopeArtifactSha256 } : {}),
    ...(stringOrUndefined(input.properties['canonical_rdf_sha256'])
      ? { canonical_rdf_sha256: String(input.properties['canonical_rdf_sha256']) }
      : {}),
    ...(stringOrUndefined(input.properties['canonical_rdf_artifact_urn'])
      ? { canonical_rdf_artifact_urn: String(input.properties['canonical_rdf_artifact_urn']) }
      : {}),
    ...(stringOrUndefined(input.properties['published_at']) ? { published_at: String(input.properties['published_at']) } : {}),
    ...(stringOrUndefined(input.properties['publisher']) ? { publisher: String(input.properties['publisher']) } : {}),
    ...(stringOrUndefined(input.properties['policy_version']) ? { policy_version: String(input.properties['policy_version']) } : {}),
    ...(stringOrUndefined(input.properties['validation_status']) ? { validation_status: String(input.properties['validation_status']) } : {}),
    ...(stringOrUndefined(input.properties['validation_report']) ? { validation_report: String(input.properties['validation_report']) } : {}),
    ...(stringOrUndefined(input.properties['signature_ref']) ? { signature_ref: String(input.properties['signature_ref']) } : {}),
    ...(stringOrUndefined(input.properties['approved_by']) ? { approved_by: String(input.properties['approved_by']) } : {}),
    ...(stringOrUndefined(input.properties['approved_role']) ? { approved_role: String(input.properties['approved_role']) } : {}),
    artifacts: input.artifacts,
    governance_artifacts: input.governance_artifacts,
    detached_signatures: input.detached_signatures,
    ...(provenance_refs &&
    (provenance_refs.upstream_skill_version_urns?.length || provenance_refs.openlineage)
      ? {
          provenance_refs: {
            ...(provenance_refs.upstream_skill_version_urns?.length
              ? { upstream_version_urns: provenance_refs.upstream_skill_version_urns }
              : {}),
            ...(provenance_refs.openlineage ? { openlineage: provenance_refs.openlineage } : {}),
          },
        }
      : {}),
    ...(revokedAt || revokedBy || revocationReason
      ? {
          revocation_refs: {
            ...(revokedAt ? { revoked_at: revokedAt } : {}),
            ...(revokedBy ? { revoked_by: revokedBy } : {}),
            ...(revocationReason ? { revocation_reason: revocationReason } : {}),
          },
        }
      : {}),
    ...(supersededByVersionUrn
      ? { supersession_refs: { superseded_by_version_urn: supersededByVersionUrn } }
      : {}),
    ...(input.transparency_append_intent ? { transparency_append_intent: input.transparency_append_intent } : {}),
  };
}

// Keys that mirror stored artifacts (canonical RDF, frozen envelope) rather
// than the publication itself. They must be excluded from the canonical RDF
// projection both when it is written and when it is re-derived for
// verification, or the semantic digest drifts on every re-projection.
const PUBLICATION_PROJECTION_PROP_KEYS: ReadonlySet<string> = new Set([
  'canonical_rdf_sha256',
  'canonical_rdf_artifact_urn',
  'publication_envelope_artifact_urn',
  'publication_envelope_sha256',
]);

// The frozen publication envelope artifact reference is recorded on the
// version but is excluded from the canonical payload it describes: including
// it would make the payload depend on the artifact that stores it.
const PUBLICATION_ENVELOPE_PROP_KEYS: ReadonlySet<string> = new Set([
  'publication_envelope_artifact_urn',
  'publication_envelope_sha256',
]);

// Prepared publications (single-request sign-then-publish). A prepare call
// pins the exact envelope that publish will freeze — including the
// server-volatile values (published_at, updated_at, the transparency
// append-intent props) — as a CAS artifact. Publish then re-derives the
// candidate from current state with those values pinned and refuses to
// proceed (409, *_PUBLISH_PREPARED_STALE) unless the bytes are identical, so
// a client signature always covers exactly the frozen payload.
const PREPARED_PUBLICATION_SCHEMA = 'prepared-publication/v1';
const PREPARED_PUBLICATION_TTL_MS = 30 * 60 * 1000;
const PREPARED_PUBLICATION_EXCLUDED_EDGE_PREDICATES: ReadonlySet<string> = new Set([
  'sg:hasCanonicalRdf',
  'prov:wasGeneratedBy',
  'sg:hasDetachedSignature',
  'sg:hasPublicationEnvelope',
]);

type PreparedPublicationRecord = {
  schema: typeof PREPARED_PUBLICATION_SCHEMA;
  publication_urn: string;
  logical_urn: string;
  entity_type: 'SKILL_VERSION' | 'AGENT_VERSION';
  logical_key: string;
  created_at: string;
  expires_at: string;
  inputs: {
    author: string;
    note: string | null;
    governance: import('../ports/registry-service.js').RegistryGovernanceInput | null;
  };
  pinned: {
    published_at: string;
    updated_at: string;
    append_intent: import('../ports/registry-service.js').RegistryTransparencyAppendIntentRef | null;
    artifact_append_intents: Array<{
      role: 'policy_package' | 'validation_report';
      artifact_urn: string;
      intent: import('../ports/registry-service.js').RegistryTransparencyAppendIntentRef;
    }>;
  };
  candidate: {
    properties: Record<string, unknown>;
    governance_artifacts: import('../ports/registry-service.js').RegistryGovernanceArtifactRef[];
    governance_artifact_payloads: Array<{
      role: 'policy_package' | 'validation_report';
      artifact_urn: string;
      payload: Record<string, unknown>;
    }>;
    canonical_json: string;
    canonical_json_sha256: string;
    canonical_rdf_nquads: string | null;
    canonical_rdf_sha256: string | null;
  };
};

// Merges the publication's existing governance-artifact refs with the refs a
// publish will newly attach, preserving the exact grouping/order
// loadGovernanceArtifacts emits (role groups: policy, validation,
// certification, review) so prepared candidates match the frozen envelope.
// A total order over governance artifact refs: role group first, then artifact
// URN. The graph backend does not guarantee edge iteration order, and the
// prepared-publication candidate and the publish-time frozen envelope are
// derived through different paths — an unstable order changes the canonical
// JSON bytes between the two derivations and trips the prepared-stale guard
// even though artifact membership and intents are identical.
export function sortGovernanceArtifactRefs(
  refs: import('../ports/registry-service.js').RegistryGovernanceArtifactRef[],
): import('../ports/registry-service.js').RegistryGovernanceArtifactRef[] {
  const roleOrder = ['policy_package', 'validation_report', 'certification_evidence', 'review_evidence'];
  return [...refs].sort((a, b) => {
    const byRole = roleOrder.indexOf(a.role) - roleOrder.indexOf(b.role);
    if (byRole !== 0) return byRole;
    return a.artifact_urn.localeCompare(b.artifact_urn);
  });
}

function mergeGovernanceArtifactRefs(
  existing: import('../ports/registry-service.js').RegistryGovernanceArtifactRef[],
  additions: import('../ports/registry-service.js').RegistryGovernanceArtifactRef[],
): import('../ports/registry-service.js').RegistryGovernanceArtifactRef[] {
  const merged = [...existing];
  const roleOrder = ['policy_package', 'validation_report', 'certification_evidence', 'review_evidence'];
  for (const addition of additions) {
    const existingIndex = merged.findIndex(
      (entry) => entry.role === addition.role && entry.artifact_urn === addition.artifact_urn,
    );
    if (existingIndex !== -1) {
      if (addition.transparency_append_intent && !merged[existingIndex]?.transparency_append_intent) {
        merged[existingIndex] = {
          ...merged[existingIndex]!,
          transparency_append_intent: addition.transparency_append_intent,
        };
      }
      continue;
    }
    const lastOfRole = merged.reduce(
      (acc, entry, index) => (entry.role === addition.role ? index : acc),
      -1,
    );
    if (lastOfRole !== -1) {
      merged.splice(lastOfRole + 1, 0, addition);
      continue;
    }
    const insertAt = merged.findIndex(
      (entry) => roleOrder.indexOf(entry.role) > roleOrder.indexOf(addition.role),
    );
    if (insertAt === -1) {
      merged.push(addition);
    } else {
      merged.splice(insertAt, 0, addition);
    }
  }
  return sortGovernanceArtifactRefs(merged);
}

function preparedPublicationInputsFingerprint(input: {
  author: string;
  note?: string;
  governance?: import('../ports/registry-service.js').RegistryGovernanceInput;
}): string {
  return canonicalJsonString({
    author: input.author,
    note: input.note ?? null,
    governance: input.governance ?? null,
  });
}

// Pure replication of createGovernanceArtifact's content addressing so a
// prepared candidate can reference the deterministic artifact URNs before
// anything is persisted.
function pureGovernanceArtifactRef(input: {
  role: 'policy_package' | 'validation_report';
  logical_key: string;
  publication_urn: string;
  payload: Record<string, unknown>;
}): import('../ports/registry-service.js').RegistryGovernanceArtifactRef {
  const content = canonicalJsonString({
    role: input.role,
    logical_key: input.logical_key,
    publication_urn: input.publication_urn,
    payload: input.payload,
  });
  const sha256 = sha256Hex(Buffer.from(content, 'utf8'));
  return { role: input.role, artifact_urn: artifactUrn(sha256), sha256 };
}

// Task evidence for a prepared publication, rebuilt from the pinned candidate
// properties (same fields buildPublicationGovernance records).
function taskEvidenceFromPublicationProperties(properties: Record<string, unknown>) {
  return {
    ...(stringOrUndefined(properties['publisher']) ? { publisher: String(properties['publisher']) } : {}),
    ...(stringOrUndefined(properties['policy_version']) ? { policy_version: String(properties['policy_version']) } : {}),
    ...(stringOrUndefined(properties['validation_status'])
      ? { validation_status: String(properties['validation_status']) }
      : {}),
    ...(stringOrUndefined(properties['validation_report'])
      ? { validation_report: String(properties['validation_report']) }
      : {}),
    ...(stringOrUndefined(properties['canonical_json_sha256'])
      ? { canonical_json_sha256: String(properties['canonical_json_sha256']) }
      : {}),
    ...(stringOrUndefined(properties['signature_ref']) ? { signature_ref: String(properties['signature_ref']) } : {}),
    ...(stringOrUndefined(properties['approved_by']) ? { approved_by: String(properties['approved_by']) } : {}),
    ...(stringOrUndefined(properties['approved_role']) ? { approved_role: String(properties['approved_role']) } : {}),
  };
}

// Predicate types accepted for the policy gates that require build evidence.
const BUILD_PROVENANCE_PREDICATE_TYPES: ReadonlySet<string> = new Set([
  'https://slsa.dev/provenance/v1',
  'https://slsa.dev/provenance/v0.2',
]);
const SBOM_PREDICATE_TYPES: ReadonlySet<string> = new Set([
  'https://spdx.dev/document',
  'https://cyclonedx.org/bom',
]);

function omitProperties(properties: Record<string, unknown>, keys: ReadonlySet<string>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (keys.has(key)) continue;
    result[key] = value;
  }
  return result;
}

function omitPublicationEnvelopeProps(properties: Record<string, unknown>): Record<string, unknown> {
  return omitProperties(properties, PUBLICATION_ENVELOPE_PROP_KEYS);
}

// DSSE Pre-Authentication Encoding (PAE), per the DSSE specification. Payloads
// ingested here are JSON in-toto statements, so the PAE is valid UTF-8 and can
// go through the string-based signature verifier.
function dssePae(payloadType: string, payloadText: string, payloadByteLength: number): string {
  return `DSSEv1 ${Buffer.byteLength(payloadType, 'utf8')} ${payloadType} ${payloadByteLength} ${payloadText}`;
}

// sha256 digests declared by an in-toto statement's subject entries.
function collectAttestationSubjectSha256(statement: Record<string, unknown>): string[] {
  const subjects = statement['subject'];
  if (!Array.isArray(subjects)) return [];
  const digests = new Set<string>();
  for (const subject of subjects) {
    if (!subject || typeof subject !== 'object' || Array.isArray(subject)) continue;
    const digest = (subject as Record<string, unknown>)['digest'];
    if (!digest || typeof digest !== 'object' || Array.isArray(digest)) continue;
    const sha256 = (digest as Record<string, unknown>)['sha256'];
    if (typeof sha256 === 'string' && /^[0-9a-f]{64}$/.test(sha256.toLowerCase())) {
      digests.add(sha256.toLowerCase());
    }
  }
  return [...digests];
}

function extractLogicalKeyFromPublicationUrn(publicationUrn: string) {  if (publicationUrn.startsWith('urn:sg:skill-version:')) {
    return publicationUrn.slice('urn:sg:skill-version:'.length).replace(/@v\d+$/, '');
  }
  if (publicationUrn.startsWith('urn:sg:agent-version:')) {
    return publicationUrn.slice('urn:sg:agent-version:'.length).replace(/@v\d+$/, '');
  }
  throw new RegistryCoreError('TRANSPARENCY_APPEND_INTENT_INVALID', `Unsupported publication URN: ${publicationUrn}`);
}

function versionFromProperties(properties: Record<string, unknown>): number {
  const value = properties['version'];
  return typeof value === 'number' ? value : Number(value ?? 0);
}

function extractVersionFromPublicationUrn(publicationUrn: string) {
  const match = /@v(\d+)$/.exec(publicationUrn);
  const value = match?.[1] ? Number(match[1]) : NaN;
  if (!Number.isInteger(value)) {
    throw new RegistryCoreError('TRANSPARENCY_APPEND_INTENT_INVALID', `Publication URN is missing a version suffix: ${publicationUrn}`);
  }
  return value;
}

function transparencyAppendIntentProps(
  value: import('../ports/registry-service.js').RegistryTransparencyAppendIntentRef,
) {
  return {
    transparency_append_log_id: value.log_id,
    transparency_append_source_type: value.source_type,
    transparency_append_request_id: value.request_id,
    transparency_append_request_record_sha256: value.request_record_sha256,
    transparency_append_s3_uri: value.s3_uri,
    ...(value.tessera_submission_status ? { transparency_append_tessera_submission_status: value.tessera_submission_status } : {}),
    ...(value.tessera_submission_error ? { transparency_append_tessera_submission_error: value.tessera_submission_error } : {}),
    ...(typeof value.tessera_entry_index === 'number' ? { transparency_append_tessera_entry_index: value.tessera_entry_index } : {}),
    ...(value.tessera_add_url ? { transparency_append_tessera_add_url: value.tessera_add_url } : {}),
    ...(value.tessera_checkpoint_url ? { transparency_append_tessera_checkpoint_url: value.tessera_checkpoint_url } : {}),
    ...(typeof value.tessera_checkpoint_tree_size === 'number'
      ? { transparency_append_tessera_checkpoint_tree_size: value.tessera_checkpoint_tree_size }
      : {}),
    ...(value.tessera_checkpoint_root_hash
      ? { transparency_append_tessera_checkpoint_root_hash: value.tessera_checkpoint_root_hash }
      : {}),
    ...(value.tessera_checkpoint_note_sha256
      ? { transparency_append_tessera_checkpoint_note_sha256: value.tessera_checkpoint_note_sha256 }
      : {}),
    ...(value.tessera_checkpoint_artifact_urn
      ? { transparency_append_tessera_checkpoint_artifact_urn: value.tessera_checkpoint_artifact_urn }
      : {}),
    ...(value.bucket ? { transparency_append_bucket: value.bucket } : {}),
    ...(value.key ? { transparency_append_key: value.key } : {}),
  };
}

// Re-derives and verifies a fetched native-log entry against the intent the
// registry recorded at append time. Every check must pass for the entry to
// count as reconciled.
function checkReconciledLogEntry(input: {
  entry: Record<string, unknown>;
  intent: import('../ports/registry-service.js').RegistryTransparencyAppendIntentRef;
  publicKeyPem: string;
  keyHint: Buffer | null;
}): import('../ports/registry-service.js').RegistryTransparencyReconciliationCheck[] {
  const checks: import('../ports/registry-service.js').RegistryTransparencyReconciliationCheck[] = [];
  const recordB64 = typeof input.entry['record_b64'] === 'string' ? input.entry['record_b64'] : '';
  const recordBytes = recordB64 ? Buffer.from(recordB64, 'base64') : Buffer.alloc(0);
  const recordSha256 = recordB64 ? sha256Hex(recordBytes) : '';
  checks.push({
    name: 'record_digest_matches_staged_intent',
    ok: recordSha256 !== '' && recordSha256 === input.intent.request_record_sha256,
    ...(recordSha256 !== input.intent.request_record_sha256
      ? { detail: `staged=${input.intent.request_record_sha256} observed=${recordSha256 || 'none'}` }
      : {}),
  });
  const entrySha256 = typeof input.entry['record_sha256'] === 'string' ? input.entry['record_sha256'] : '';
  checks.push({
    name: 'record_digest_matches_entry',
    ok: recordSha256 !== '' && recordSha256 === entrySha256,
    ...(recordSha256 !== entrySha256 ? { detail: `entry=${entrySha256 || 'none'}` } : {}),
  });

  const leafHash = recordB64 ? rfc6962LeafHashBytes(recordBytes) : null;
  const entryLeafHash =
    typeof input.entry['leaf_hash'] === 'string' ? Buffer.from(input.entry['leaf_hash'], 'hex') : null;
  checks.push({
    name: 'leaf_hash_matches_record',
    ok: Boolean(leafHash && entryLeafHash && leafHash.equals(entryLeafHash)),
    ...(leafHash && entryLeafHash && !leafHash.equals(entryLeafHash)
      ? { detail: `expected=${leafHash.toString('hex')} entry=${entryLeafHash.toString('hex')}` }
      : {}),
  });

  const proofRaw = input.entry['proof'];
  const proof =
    proofRaw && typeof proofRaw === 'object' && !Array.isArray(proofRaw)
      ? (proofRaw as { tree_size?: unknown; root_hash?: unknown; hashes?: unknown })
      : null;
  const proofHashes =
    proof && Array.isArray(proof.hashes)
      ? proof.hashes.filter((hash): hash is string => typeof hash === 'string')
      : null;
  const proofTreeSize = proof && typeof proof.tree_size === 'number' ? proof.tree_size : null;
  const proofRootHash = proof && typeof proof.root_hash === 'string' ? proof.root_hash : null;
  checks.push({
    name: 'inclusion_proof_present',
    ok: proofHashes !== null && proofTreeSize !== null && proofRootHash !== null,
  });

  let inclusionDetail: string | undefined;
  let inclusionOk = false;
  if (leafHash && proofHashes && proofTreeSize !== null && proofRootHash) {
    const inclusion = verifyRfc6962Inclusion({
      leafHash,
      logIndex: BigInt(input.intent.tessera_entry_index ?? 0),
      treeSize: BigInt(proofTreeSize),
      proofHashes: proofHashes.map((hash) => Buffer.from(hash, 'hex')),
      rootHash: Buffer.from(proofRootHash, 'hex'),
    });
    inclusionOk = inclusion.verified;
    if (!inclusion.verified) inclusionDetail = inclusion.error;
  }
  checks.push({
    name: 'inclusion_proof_valid',
    ok: inclusionOk,
    ...(inclusionDetail ? { detail: inclusionDetail } : {}),
  });

  const checkpointRaw = input.entry['checkpoint'];
  const checkpoint =
    checkpointRaw && typeof checkpointRaw === 'object' && !Array.isArray(checkpointRaw)
      ? (checkpointRaw as { envelope?: unknown })
      : null;
  let checkpointDetail: string | undefined;
  let checkpointOk = false;
  let checkpointMatchesRoot = false;
  if (checkpoint && typeof checkpoint.envelope === 'string' && input.keyHint) {
    const noteOutcome = verifySignedNote({
      envelope: checkpoint.envelope,
      publicKeyPem: input.publicKeyPem,
      keyHintSource: input.keyHint,
    });
    checkpointOk = noteOutcome.verified;
    if (!noteOutcome.verified) checkpointDetail = noteOutcome.error;
    if (noteOutcome.verified && noteOutcome.note && proofTreeSize !== null && proofRootHash) {
      const parsed = parseCheckpointNote(noteOutcome.note);
      checkpointMatchesRoot = Boolean(
        parsed &&
          parsed.logSize === BigInt(proofTreeSize) &&
          parsed.logHash.equals(Buffer.from(proofRootHash, 'hex')),
      );
    }
  } else if (!input.keyHint) {
    checkpointDetail = 'configured log public key could not be parsed';
  } else {
    checkpointDetail = 'entry carries no checkpoint envelope';
  }
  checks.push({
    name: 'checkpoint_signature_valid',
    ok: checkpointOk,
    ...(checkpointDetail ? { detail: checkpointDetail } : {}),
  });
  checks.push({
    name: 'checkpoint_matches_inclusion_root',
    ok: checkpointMatchesRoot,
  });
  return checks;
}

function readTransparencyAppendIntentFromProperties(
  properties: Record<string, unknown>,
): import('../ports/registry-service.js').RegistryTransparencyAppendIntentRef | undefined {
  const log_id = stringOrUndefined(properties['transparency_append_log_id']);
  const source_type = properties['transparency_append_source_type'];
  const request_id = stringOrUndefined(properties['transparency_append_request_id']);
  const request_record_sha256 = stringOrUndefined(properties['transparency_append_request_record_sha256']);
  const s3_uri = stringOrUndefined(properties['transparency_append_s3_uri']);
  if (
    !log_id ||
    (source_type !== 'publication_envelope' && source_type !== 'governance_event') ||
    !request_id ||
    !request_record_sha256 ||
    !s3_uri
  ) {
    return undefined;
  }
  const bucket = stringOrUndefined(properties['transparency_append_bucket']);
  const key = stringOrUndefined(properties['transparency_append_key']);
  const tesseraSubmissionStatus =
    properties['transparency_append_tessera_submission_status'] === 'submitted' ||
    properties['transparency_append_tessera_submission_status'] === 'staged_only'
      ? properties['transparency_append_tessera_submission_status']
      : undefined;
  const tesseraSubmissionError = stringOrUndefined(properties['transparency_append_tessera_submission_error']);
  const tesseraEntryIndex =
    typeof properties['transparency_append_tessera_entry_index'] === 'number'
      ? properties['transparency_append_tessera_entry_index']
      : undefined;
  const tesseraAddUrl = stringOrUndefined(properties['transparency_append_tessera_add_url']);
  const tesseraCheckpointUrl = stringOrUndefined(properties['transparency_append_tessera_checkpoint_url']);
  const tesseraCheckpointTreeSize =
    typeof properties['transparency_append_tessera_checkpoint_tree_size'] === 'number'
      ? properties['transparency_append_tessera_checkpoint_tree_size']
      : undefined;
  const tesseraCheckpointRootHash = stringOrUndefined(properties['transparency_append_tessera_checkpoint_root_hash']);
  const tesseraCheckpointNoteSHA256 = stringOrUndefined(properties['transparency_append_tessera_checkpoint_note_sha256']);
  const tesseraCheckpointArtifactUrn = stringOrUndefined(properties['transparency_append_tessera_checkpoint_artifact_urn']);
  return {
    log_id,
    source_type,
    request_id,
    request_record_sha256,
    s3_uri,
    ...(tesseraSubmissionStatus ? { tessera_submission_status: tesseraSubmissionStatus } : {}),
    ...(tesseraSubmissionError ? { tessera_submission_error: tesseraSubmissionError } : {}),
    ...(typeof tesseraEntryIndex === 'number' ? { tessera_entry_index: tesseraEntryIndex } : {}),
    ...(tesseraAddUrl ? { tessera_add_url: tesseraAddUrl } : {}),
    ...(tesseraCheckpointUrl ? { tessera_checkpoint_url: tesseraCheckpointUrl } : {}),
    ...(typeof tesseraCheckpointTreeSize === 'number' ? { tessera_checkpoint_tree_size: tesseraCheckpointTreeSize } : {}),
    ...(tesseraCheckpointRootHash ? { tessera_checkpoint_root_hash: tesseraCheckpointRootHash } : {}),
    ...(tesseraCheckpointNoteSHA256 ? { tessera_checkpoint_note_sha256: tesseraCheckpointNoteSHA256 } : {}),
    ...(tesseraCheckpointArtifactUrn ? { tessera_checkpoint_artifact_urn: tesseraCheckpointArtifactUrn } : {}),
    ...(bucket ? { bucket } : {}),
    ...(key ? { key } : {}),
  };
}

function maybeTransparencyAppendIntentProp(properties: Record<string, unknown>) {
  const transparencyAppendIntent = readTransparencyAppendIntentFromProperties(properties);
  return transparencyAppendIntent ? { transparency_append_intent: transparencyAppendIntent } : {};
}

function buildAppendIntentVerification(
  value: import('../ports/registry-service.js').RegistryTransparencyAppendIntentRef,
): import('../ports/registry-service.js').RegistryTransparencyAppendIntentVerification {
  const committed_by_checkpoint =
    value.tessera_submission_status === 'submitted' &&
    typeof value.tessera_entry_index === 'number' &&
    typeof value.tessera_checkpoint_tree_size === 'number' &&
    value.tessera_checkpoint_tree_size > value.tessera_entry_index &&
    Boolean(value.tessera_checkpoint_url) &&
    Boolean(value.tessera_checkpoint_root_hash) &&
    Boolean(value.tessera_checkpoint_note_sha256);
  const checkpoint_artifact_present = Boolean(value.tessera_checkpoint_artifact_urn);

  const verification_status =
    value.tessera_submission_status === 'submitted'
      ? committed_by_checkpoint
        ? ('committed' as const)
        : ('staged_only' as const)
      : value.tessera_submission_error
        ? ('submission_failed' as const)
        : ('staged_only' as const);

  return {
    source_type: value.source_type,
    request_id: value.request_id,
    request_record_sha256: value.request_record_sha256,
    s3_uri: value.s3_uri,
    ...(value.tessera_submission_status ? { tessera_submission_status: value.tessera_submission_status } : {}),
    ...(value.tessera_submission_error ? { tessera_submission_error: value.tessera_submission_error } : {}),
    ...(typeof value.tessera_entry_index === 'number' ? { tessera_entry_index: value.tessera_entry_index } : {}),
    ...(value.tessera_add_url ? { tessera_add_url: value.tessera_add_url } : {}),
    ...(value.tessera_checkpoint_url ? { tessera_checkpoint_url: value.tessera_checkpoint_url } : {}),
    ...(typeof value.tessera_checkpoint_tree_size === 'number'
      ? { tessera_checkpoint_tree_size: value.tessera_checkpoint_tree_size }
      : {}),
    ...(value.tessera_checkpoint_root_hash ? { tessera_checkpoint_root_hash: value.tessera_checkpoint_root_hash } : {}),
    ...(value.tessera_checkpoint_note_sha256
      ? { tessera_checkpoint_note_sha256: value.tessera_checkpoint_note_sha256 }
      : {}),
    ...(value.tessera_checkpoint_artifact_urn
      ? { tessera_checkpoint_artifact_urn: value.tessera_checkpoint_artifact_urn }
      : {}),
    checkpoint_artifact_present,
    committed_by_checkpoint,
    verification_status,
  };
}

const GOVERNANCE_LOG_URN = 'urn:sg:governance-log:registry';

function sanitizePathSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-');
}

function normalizePem(value: string) {
  return value.trim().endsWith('\n') ? value.trim() : `${value.trim()}\n`;
}

function assertPublicKeyUsable(publicKeyPem: string) {
  createPublicKey(normalizePem(publicKeyPem));
}

function parseSignatureBytes(signature: string) {
  if (signature.startsWith('base64:')) {
    return Buffer.from(signature.slice('base64:'.length), 'base64');
  }
  if (signature.startsWith('hex:')) {
    return Buffer.from(signature.slice('hex:'.length), 'hex');
  }
  throw new RegistryCoreError(
    'DETACHED_SIGNATURE_FORMAT_INVALID',
    'Detached signature must use a supported encoding prefix such as base64: or hex:.',
  );
}

function verifyDetachedSignatureBytes(input: {
  algorithm: string;
  public_key_pem: string;
  message: string;
  signature: string;
}) {
  try {
    const key = createPublicKey(normalizePem(input.public_key_pem));
    const signatureBytes = parseSignatureBytes(input.signature);
    const message = Buffer.from(input.message, 'utf8');
    switch (input.algorithm) {
      case 'ed25519':
      case 'ed448':
        return verifySignature(null, message, key, signatureBytes);
      case 'rsa-sha256':
      case 'ecdsa-p256-sha256':
      case 'ecdsa-sha256':
        return verifySignature('sha256', message, key, signatureBytes);
      case 'ecdsa-p384-sha384':
      case 'ecdsa-sha384':
        return verifySignature('sha384', message, key, signatureBytes);
      default:
        return false;
    }
  } catch {
    return false;
  }
}

function isTransparencyProofPayload(
  value: unknown,
): value is {
  log_id: string;
  tree_size: number;
  leaf_index: number;
  root_hash: string;
  proof_hashes: string[];
  checkpoint_body: string;
  checkpoint_signature: string;
  transparency_log_ref?: string;
  envelope_sha256: string;
  signature_artifact_urn: string;
} {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['log_id'] === 'string' &&
    typeof candidate['tree_size'] === 'number' &&
    Number.isInteger(candidate['tree_size']) &&
    candidate['tree_size'] > 0 &&
    typeof candidate['leaf_index'] === 'number' &&
    Number.isInteger(candidate['leaf_index']) &&
    candidate['leaf_index'] >= 0 &&
    typeof candidate['root_hash'] === 'string' &&
    Array.isArray(candidate['proof_hashes']) &&
    candidate['proof_hashes'].every((item) => typeof item === 'string') &&
    typeof candidate['checkpoint_body'] === 'string' &&
    typeof candidate['checkpoint_signature'] === 'string' &&
    typeof candidate['envelope_sha256'] === 'string' &&
    typeof candidate['signature_artifact_urn'] === 'string' &&
    (candidate['transparency_log_ref'] === undefined || typeof candidate['transparency_log_ref'] === 'string')
  );
}

function buildTransparencyLeafPayload(input: {
  log_id: string;
  envelope_sha256: string;
  signer: string;
  key_ref: string;
  algorithm: string;
  signature: string;
}) {
  return canonicalJsonString({
    log_id: input.log_id,
    envelope_sha256: input.envelope_sha256,
    signer: input.signer,
    key_ref: input.key_ref,
    algorithm: input.algorithm,
    signature: input.signature,
  });
}

function parseHashBytes(value: string) {
  if (value.startsWith('base64:')) return Buffer.from(value.slice('base64:'.length), 'base64');
  if (value.startsWith('hex:')) return Buffer.from(value.slice('hex:'.length), 'hex');
  return Buffer.from(value, 'utf8');
}

function rfc6962LeafHash(leafPayload: string) {
  return createHash('sha256').update(Buffer.concat([Buffer.from([0x00]), Buffer.from(leafPayload, 'utf8')])).digest();
}

function rfc6962NodeHash(left: Uint8Array, right: Uint8Array) {
  return createHash('sha256').update(Buffer.concat([Buffer.from([0x01]), Buffer.from(left), Buffer.from(right)])).digest();
}

function verifyRfc6962InclusionProof(input: {
  leaf_hash: Uint8Array;
  leaf_index: number;
  tree_size: number;
  proof_hashes: string[];
  expected_root_hash: string;
}) {
  if (input.tree_size <= 0 || input.leaf_index < 0 || input.leaf_index >= input.tree_size) return false;
  // Standard RFC 6962 audit-path fold: at each level the sibling is on the
  // left when the current node is a right child (odd index) or is the
  // rightmost node of an incomplete subtree (index === last).
  let index = input.leaf_index;
  let last = input.tree_size - 1;
  let hash = Buffer.from(input.leaf_hash);
  for (const sibling of input.proof_hashes) {
    const siblingBytes = parseHashBytes(sibling);
    if ((index & 1) === 1 || index === last) {
      hash = rfc6962NodeHash(siblingBytes, hash);
    } else {
      hash = rfc6962NodeHash(hash, siblingBytes);
    }
    index >>= 1;
    last >>= 1;
  }
  return hash.equals(parseHashBytes(input.expected_root_hash));
}

function verifyRfc6962ConsistencyProof(input: {
  old_tree_size: number;
  new_tree_size: number;
  old_root_hash: string;
  new_root_hash: string;
  proof_hashes: string[];
}) {
  if (input.old_tree_size <= 0 || input.new_tree_size <= 0 || input.old_tree_size > input.new_tree_size) return false;
  if (input.old_tree_size === input.new_tree_size) {
    return input.old_root_hash === input.new_root_hash;
  }

  let fn = input.old_tree_size - 1;
  let sn = input.new_tree_size - 1;
  const proof = input.proof_hashes.map((hash) => parseHashBytes(hash));
  if (proof.length === 0) return false;

  while ((fn & 1) === 1) {
    fn >>= 1;
    sn >>= 1;
  }

  let oldHash = proof[0];
  let newHash = proof[0];
  let proofIndex = 1;
  if (!oldHash || !newHash) return false;

  while (proofIndex < proof.length) {
    if (sn === 0) break;
    const next = proof[proofIndex];
    if (!next) return false;
    if ((fn & 1) === 1 || fn === sn) {
      oldHash = rfc6962NodeHash(next, oldHash);
      newHash = rfc6962NodeHash(next, newHash);
      while ((fn & 1) === 0 && fn !== 0) {
        fn >>= 1;
        sn >>= 1;
      }
    } else {
      newHash = rfc6962NodeHash(newHash, next);
    }
    fn >>= 1;
    sn >>= 1;
    proofIndex += 1;
  }

  return oldHash.equals(parseHashBytes(input.old_root_hash)) && newHash.equals(parseHashBytes(input.new_root_hash));
}

function parseCheckpointBody(body: string): { origin: string; tree_size: number; root_hash: string } | null {
  const lines = body.trimEnd().split('\n');
  if (lines.length < 3) return null;
  const treeSize = Number(lines[1]);
  if (!Number.isInteger(treeSize) || treeSize < 0) return null;
  return {
    origin: lines[0] ?? '',
    tree_size: treeSize,
    root_hash: lines[2] ?? '',
  };
}

type NormalizedCheckpointSubmission = {
  checkpoint_body: string;
  checkpoint_signature: string;
  note_format: 'raw_signed_note' | 'normalized_checkpoint';
  signature_count: number;
  signatures: import('../ports/registry-service.js').RegistryTransparencyNoteSignature[];
  signed_note?: string;
  signed_note_signer?: string;
  signed_note_key_hint?: string;
};

function normalizeCheckpointSubmission(input: {
  checkpoint_body?: string;
  checkpoint_signature?: string;
  signed_note?: string;
}): NormalizedCheckpointSubmission {
  if (input.signed_note) {
    const parsed = parseSignedCheckpointNote(input.signed_note);
    if (!parsed) {
      throw new RegistryCoreError('TRANSPARENCY_CHECKPOINT_INVALID', 'Signed note format is invalid.');
    }
    return parsed;
  }
  if (!input.checkpoint_body || !input.checkpoint_signature) {
    throw new RegistryCoreError('TRANSPARENCY_CHECKPOINT_INVALID', 'Checkpoint body and signature are required.');
  }
  return {
    checkpoint_body: input.checkpoint_body,
    checkpoint_signature: input.checkpoint_signature,
    note_format: 'normalized_checkpoint',
    signature_count: 1,
    signatures: [buildNormalizedCheckpointSignature(input.checkpoint_signature)],
  };
}

function parseSignedCheckpointNote(signedNote: string): NormalizedCheckpointSubmission | null {
  const normalizedSignedNote = normalizeSignedNoteLineEndings(signedNote);
  const separator = '\n\n';
  const splitIndex = normalizedSignedNote.indexOf(separator);
  if (splitIndex <= 0) return null;
  const checkpointBody = normalizedSignedNote.slice(0, splitIndex + 1);
  const signatureLines = normalizedSignedNote
    .slice(splitIndex + separator.length)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const signatures = signatureLines
    .map((line, index) => parseSignedCheckpointSignatureLine(line, index))
    .filter(
      (value): value is import('../ports/registry-service.js').RegistryTransparencyNoteSignature => value !== null,
    );
  if (signatures.length !== signatureLines.length || signatures.length === 0) return null;
  const primarySignature = signatures[0];
  if (!primarySignature) return null;
  return {
    checkpoint_body: checkpointBody,
    checkpoint_signature: primarySignature.signature,
    note_format: 'raw_signed_note',
    signature_count: signatures.length,
    signatures,
    signed_note: normalizedSignedNote,
    ...(primarySignature.signer ? { signed_note_signer: primarySignature.signer } : {}),
    ...(primarySignature.key_hint ? { signed_note_key_hint: primarySignature.key_hint } : {}),
  };
}

function buildNormalizedCheckpointSignature(
  signature: string,
): import('../ports/registry-service.js').RegistryTransparencyNoteSignature {
  return {
    signature_index: 0,
    signature_role: 'checkpoint',
    signature,
  };
}

function parseSignedCheckpointSignatureLine(
  line: string,
  index: number,
): import('../ports/registry-service.js').RegistryTransparencyNoteSignature | null {
  const match = /^(?:—|-)\s+(.+?)\s+([A-Za-z0-9+/=]+)$/u.exec(line);
  if (!match) return null;
  const signer = match[1]?.trim();
  const blob = match[2];
  if (!blob) return null;
  let decoded: Buffer;
  try {
    decoded = Buffer.from(blob, 'base64');
  } catch {
    return null;
  }
  if (decoded.length <= 4) return null;
  return {
    signature_index: index,
    signature_role: index === 0 ? 'checkpoint' : 'cosignature',
    signature: `base64:${decoded.subarray(4).toString('base64')}`,
    ...(signer ? { signer } : {}),
    key_hint: `base64:${decoded.subarray(0, 4).toString('base64')}`,
    raw_signature_line: line,
  };
}

function parseTransparencyNoteFormat(value: unknown): 'raw_signed_note' | 'normalized_checkpoint' | undefined {
  return value === 'raw_signed_note' || value === 'normalized_checkpoint' ? value : undefined;
}

function normalizeSignedNoteLineEndings(value: string) {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function parseTransparencyParseStrategy(value: unknown): 'signed_note' | 'checkpoint_body_signature' | undefined {
  return value === 'signed_note' || value === 'checkpoint_body_signature' ? value : undefined;
}

function parseObservationPartyType(value: unknown): 'log' | 'witness' | 'distributor' | 'peer' | undefined {
  return value === 'log' || value === 'witness' || value === 'distributor' || value === 'peer' ? value : undefined;
}

function buildCheckpointPayloadProvenance(input: {
  checkpoint_body: string;
  checkpoint_signature: string;
  signed_note: string | undefined;
  note_format: 'raw_signed_note' | 'normalized_checkpoint' | undefined;
}) {
  const noteFormat = input.note_format ?? (input.signed_note ? 'raw_signed_note' : 'normalized_checkpoint');
  if (noteFormat === 'raw_signed_note' && input.signed_note) {
    return {
      note_format: 'raw_signed_note' as const,
      parse_strategy: 'signed_note' as const,
      payload_sha256: sha256Hex(Buffer.from(input.signed_note, 'utf8')),
    };
  }
  return {
    note_format: 'normalized_checkpoint' as const,
    parse_strategy: 'checkpoint_body_signature' as const,
    payload_sha256: sha256Hex(
      Buffer.from(
        canonicalJsonString({
          checkpoint_body: input.checkpoint_body,
          checkpoint_signature: input.checkpoint_signature,
        }),
        'utf8',
      ),
    ),
  };
}

function parseTransparencyNoteSignatures(
  value: unknown,
): import('../ports/registry-service.js').RegistryTransparencyNoteSignature[] | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const signatures = parsed
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const signatureIndex = numberOrUndefined((entry as Record<string, unknown>)['signature_index']);
      const signatureRole = (entry as Record<string, unknown>)['signature_role'];
      const signature = stringOrUndefined((entry as Record<string, unknown>)['signature']);
      if (
        typeof signatureIndex !== 'number' ||
        (signatureRole !== 'checkpoint' && signatureRole !== 'cosignature') ||
        !signature
      ) {
        return null;
      }
      return {
        signature_index: signatureIndex,
        signature_role: signatureRole,
        signature,
        ...(stringOrUndefined((entry as Record<string, unknown>)['signer'])
          ? { signer: stringOrUndefined((entry as Record<string, unknown>)['signer']) }
          : {}),
        ...(stringOrUndefined((entry as Record<string, unknown>)['key_hint'])
          ? { key_hint: stringOrUndefined((entry as Record<string, unknown>)['key_hint']) }
          : {}),
        ...(stringOrUndefined((entry as Record<string, unknown>)['raw_signature_line'])
          ? { raw_signature_line: stringOrUndefined((entry as Record<string, unknown>)['raw_signature_line']) }
          : {}),
      };
    })
    .filter(
      (
        entry,
      ): entry is import('../ports/registry-service.js').RegistryTransparencyNoteSignature => entry !== null,
    );
  return signatures.length > 0 ? signatures : undefined;
}

type TransparencyCheckpointEvidence = {
  artifact_urn: string;
  root_hash: string;
  tree_size: number;
  occurred_at: string;
  source_type: 'log' | 'witness' | 'distributor' | 'peer';
  source_id: string;
  append_only_verified?: boolean;
  witness_quorum_satisfied?: boolean;
  valid_witness_attestation_count?: number;
  witness_quorum_required?: number;
};

function buildTransparencyDisagreements(input: {
  log_id: string;
  observations: import('../ports/registry-service.js').RegistryTransparencyCheckpointObservation[];
  checkpoints: import('../ports/registry-service.js').RegistryTransparencyCheckpointDetails[];
}) {
  const out: import('../ports/registry-service.js').RegistryTransparencyCheckpointDisagreement[] = [];
  const evidence: TransparencyCheckpointEvidence[] = [
    ...input.checkpoints.map((checkpoint) => ({
      artifact_urn: checkpoint.checkpoint_artifact_urn,
      root_hash: checkpoint.root_hash,
      tree_size: checkpoint.tree_size,
      occurred_at: checkpoint.occurred_at ?? nowIso(),
      source_type: 'log' as const,
      source_id: input.log_id,
      ...(typeof checkpoint.append_only_verified === 'boolean'
        ? { append_only_verified: checkpoint.append_only_verified }
        : {}),
      ...(typeof checkpoint.witness_quorum_satisfied === 'boolean'
        ? { witness_quorum_satisfied: checkpoint.witness_quorum_satisfied }
        : {}),
      ...(typeof checkpoint.valid_witness_attestation_count === 'number'
        ? { valid_witness_attestation_count: checkpoint.valid_witness_attestation_count }
        : {}),
      ...(typeof checkpoint.witness_quorum_required === 'number'
        ? { witness_quorum_required: checkpoint.witness_quorum_required }
        : {}),
    })),
    ...input.observations.map((observation) => ({
      artifact_urn: observation.checkpoint_artifact_urn,
      root_hash: observation.root_hash,
      tree_size: observation.tree_size,
      occurred_at: observation.observed_at,
      source_type: observation.observed_from_type,
      source_id: observation.observed_from_id,
    })),
  ];

  const evidenceByTreeSize = new Map<number, TransparencyCheckpointEvidence[]>();
  for (const value of evidence) {
    const bucket = evidenceByTreeSize.get(value.tree_size);
    if (bucket) bucket.push(value);
    else evidenceByTreeSize.set(value.tree_size, [value]);
  }

  for (const [treeSize, values] of evidenceByTreeSize.entries()) {
    const rootHashes = new Map<string, TransparencyCheckpointEvidence>();
    for (const value of values) {
      if (!rootHashes.has(value.root_hash)) {
        rootHashes.set(value.root_hash, value);
      }
    }
    if (rootHashes.size > 1) {
      const roots = [...rootHashes.values()];
      for (let index = 1; index < roots.length; index += 1) {
        const left = roots[0];
        const right = roots[index];
        if (!left || !right) continue;
        out.push({
          disagreement_id: `same-size-different-root:${input.log_id}:${treeSize}:${index}`,
          log_id: input.log_id,
          kind: 'same_size_different_root',
          left_checkpoint_artifact_urn: left.artifact_urn,
          right_checkpoint_artifact_urn: right.artifact_urn,
          reason: `Observed checkpoints at tree size ${treeSize} have different roots.`,
          occurred_at: latestOccurredAt([left, right]),
          tree_size: treeSize,
          source_ids: uniqueSourceIds([left, right]),
        });
      }
    }

    const witnessEvidence = values.filter((value) => value.source_type === 'witness');
    const witnessEvidenceById = new Map<string, TransparencyCheckpointEvidence[]>();
    for (const value of witnessEvidence) {
      const bucket = witnessEvidenceById.get(value.source_id);
      if (bucket) bucket.push(value);
      else witnessEvidenceById.set(value.source_id, [value]);
    }
    for (const [witnessId, witnessValues] of witnessEvidenceById.entries()) {
      const witnessRoots = new Map<string, TransparencyCheckpointEvidence>();
      for (const value of witnessValues) {
        if (!witnessRoots.has(value.root_hash)) {
          witnessRoots.set(value.root_hash, value);
        }
      }
      if (witnessRoots.size > 1) {
        const roots = [...witnessRoots.values()];
        for (let index = 1; index < roots.length; index += 1) {
          const left = roots[0];
          const right = roots[index];
          if (!left || !right) continue;
          out.push({
            disagreement_id: `witness-equivocation:${input.log_id}:${treeSize}:${witnessId}:${index}`,
            log_id: input.log_id,
            kind: 'witness_equivocation',
            left_checkpoint_artifact_urn: left.artifact_urn,
            right_checkpoint_artifact_urn: right.artifact_urn,
            reason: `Witness ${witnessId} presented different roots at tree size ${treeSize} across time.`,
            occurred_at: latestOccurredAt([left, right]),
            tree_size: treeSize,
            source_ids: [witnessId],
          });
        }
      }
    }

    const witnessRoots = new Map<string, TransparencyCheckpointEvidence>();
    for (const value of witnessEvidence) {
      const existing = witnessRoots.get(value.root_hash);
      if (!existing || existing.source_id === value.source_id) {
        witnessRoots.set(value.root_hash, value);
      }
    }
    if (witnessRoots.size > 1) {
      const roots = [...witnessRoots.values()];
      const distinctWitnesses = new Set(roots.map((value) => value.source_id));
      if (distinctWitnesses.size > 1) {
        for (let index = 1; index < roots.length; index += 1) {
          const left = roots[0];
          const right = roots[index];
          if (!left || !right || left.source_id === right.source_id) continue;
          out.push({
            disagreement_id: `witness-disagreement:${input.log_id}:${treeSize}:${left.source_id}:${right.source_id}`,
            log_id: input.log_id,
            kind: 'witness_disagreement',
            left_checkpoint_artifact_urn: left.artifact_urn,
            right_checkpoint_artifact_urn: right.artifact_urn,
            reason: `Witnesses ${left.source_id} and ${right.source_id} reported different roots at tree size ${treeSize}.`,
            occurred_at: latestOccurredAt([left, right]),
            tree_size: treeSize,
            source_ids: uniqueSourceIds([left, right]),
          });
        }
      }
    }
  }

  const checkpoints = [...input.checkpoints].sort(
    (left, right) =>
      left.tree_size - right.tree_size || (left.occurred_at ?? '').localeCompare(right.occurred_at ?? ''),
  );
  for (let index = 1; index < checkpoints.length; index += 1) {
    const previous = checkpoints[index - 1];
    const current = checkpoints[index];
    if (!previous || !current) continue;
    if (current.tree_size > previous.tree_size && current.append_only_verified === false) {
      out.push({
        disagreement_id: `inconsistent-chain:${input.log_id}:${current.tree_size}`,
        log_id: input.log_id,
        kind: 'inconsistent_chain',
        left_checkpoint_artifact_urn: previous.checkpoint_artifact_urn,
        right_checkpoint_artifact_urn: current.checkpoint_artifact_urn,
        reason: `Checkpoint at tree size ${current.tree_size} failed append-only verification against prior history.`,
        tree_size: current.tree_size,
        source_ids: [input.log_id],
        ...(current.occurred_at ? { occurred_at: current.occurred_at } : {}),
      });
    }
    if (
      typeof previous.witness_quorum_satisfied === 'boolean' &&
      typeof current.witness_quorum_satisfied === 'boolean' &&
      typeof current.witness_quorum_required === 'number' &&
      current.witness_quorum_required > 0 &&
      previous.witness_quorum_satisfied !== current.witness_quorum_satisfied
    ) {
      out.push({
        disagreement_id: `quorum-drift:${input.log_id}:${current.tree_size}`,
        log_id: input.log_id,
        kind: 'quorum_drift',
        left_checkpoint_artifact_urn: previous.checkpoint_artifact_urn,
        right_checkpoint_artifact_urn: current.checkpoint_artifact_urn,
        reason: `Checkpoint quorum posture changed from ${previous.witness_quorum_satisfied ? 'met' : 'unmet'} to ${
          current.witness_quorum_satisfied ? 'met' : 'unmet'
        } at tree size ${current.tree_size} (${current.valid_witness_attestation_count ?? 0}/${current.witness_quorum_required} valid witness attestations).`,
        tree_size: current.tree_size,
        source_ids: [input.log_id],
        ...(current.occurred_at ? { occurred_at: current.occurred_at } : {}),
      });
    }
  }

  const evidenceBySource = new Map<string, TransparencyCheckpointEvidence[]>();
  for (const value of evidence.filter((entry) => entry.source_type !== 'log')) {
    const sourceKey = `${value.source_type}:${value.source_id}`;
    const bucket = evidenceBySource.get(sourceKey);
    if (bucket) bucket.push(value);
    else evidenceBySource.set(sourceKey, [value]);
  }
  for (const [sourceKey, values] of evidenceBySource.entries()) {
    const ordered = [...values].sort(
      (left, right) => left.occurred_at.localeCompare(right.occurred_at) || left.tree_size - right.tree_size,
    );
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1];
      const current = ordered[index];
      if (!previous || !current) continue;
      if (current.tree_size < previous.tree_size) {
        out.push({
          disagreement_id: `checkpoint-regression:${input.log_id}:${sourceKey}:${index}`,
          log_id: input.log_id,
          kind: 'checkpoint_regression',
          left_checkpoint_artifact_urn: previous.artifact_urn,
          right_checkpoint_artifact_urn: current.artifact_urn,
          reason: `${sourceKey} later presented tree size ${current.tree_size} after previously presenting ${previous.tree_size}.`,
          occurred_at: current.occurred_at,
          tree_size: current.tree_size,
          source_ids: [current.source_id],
        });
      }
    }
  }

  return out;
}

function latestOccurredAt(values: Array<{ occurred_at: string }>) {
  return [...values].sort((left, right) => right.occurred_at.localeCompare(left.occurred_at))[0]?.occurred_at ?? nowIso();
}

function uniqueSourceIds(values: Array<{ source_id: string }>) {
  return [...new Set(values.map((value) => value.source_id))];
}

function dedupeTransparencyDisagreements(
  values: import('../ports/registry-service.js').RegistryTransparencyCheckpointDisagreement[],
) {
  const byId = new Map<string, import('../ports/registry-service.js').RegistryTransparencyCheckpointDisagreement>();
  for (const value of values) {
    byId.set(value.disagreement_id, value);
  }
  return [...byId.values()];
}

function isWithinTrustWindow(properties: Record<string, unknown>, nowIsoValue: string) {
  const validFrom = stringOrUndefined(properties['valid_from']);
  const validTo = stringOrUndefined(properties['valid_to']);
  if (validFrom && nowIsoValue < validFrom) return false;
  if (validTo && nowIsoValue >= validTo) return false;
  return true;
}

function numberOrUndefined(value: unknown) {
  return typeof value === 'number' ? value : undefined;
}

function booleanOrUndefined(value: unknown) {
  return typeof value === 'boolean' ? value : undefined;
}

function nowIso() {
  return new Date().toISOString();
}
