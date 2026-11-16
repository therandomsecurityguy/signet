import type { RegistryService } from '../../../../registry/application/ports/registry-service.js';
import type { CreateSkillDraftInput, SkillVersionOperationInput } from '../../contracts/skills/lifecycle.js';

export class SkillLifecycleUseCase {
  constructor(private readonly registry: RegistryService) {}

  async listVersions(input: { skill_key: string }) {
    return await this.registry.listSkillVersions(input);
  }

  async getVersion(input: { skill_key: string; version: number }) {
    return await this.registry.getSkillVersion(input);
  }

  async getActive(input: { skill_key: string }) {
    return await this.registry.getActiveSkillVersion(input);
  }

  async getPublicationEnvelope(input: { skill_key: string; version: number }) {
    return await this.registry.getSkillPublicationEnvelope(input);
  }

  async getPublicationVerification(input: { skill_key: string; version: number }) {
    return await this.registry.getSkillPublicationVerification(input);
  }

  async getProvenance(input: { skill_key: string; version: number }) {
    const version = await this.registry.getSkillVersion(input);
    if (!version) return null;
    return await this.registry.getPublicationProvenance({ publication_urn: version.skill_version.urn });
  }

  async createDetachedSignature(input: {
    skill_key: string;
    version: number;
    signer: string;
    key_ref?: string;
    algorithm?: string;
    signature?: string;
    keyless_bundle?: Record<string, unknown>;
    signed_payload?: 'canonical_json' | 'canonical_rdf';
    transparency_log_ref?: string;
    inclusion_proof_ref?: string;
    inclusion_proof?: {
      log_id: string;
      tree_size: number;
      leaf_index: number;
      root_hash: string;
      proof_hashes: string[];
      checkpoint_body: string;
      checkpoint_signature: string;
      transparency_log_ref?: string;
    };
  }) {
    return await this.registry.createSkillDetachedSignature(input);
  }

  async createProvenanceSignature(input: {
    skill_key: string;
    version: number;
    signer: string;
    key_ref: string;
    algorithm: string;
    signature: string;
    provenance_sha256?: string;
  }) {
    return await this.registry.createSkillProvenanceSignature(input);
  }

  async attachAttestation(input: {
    publication_urn: string;
    signer: string;
    key_ref: string;
    algorithm: string;
    envelope: { payload_type: string; payload: string; signatures: Array<{ keyid?: string | undefined; sig: string }> };
    predicate_type?: string | undefined;
    note?: string | undefined;
  }) {
    return await this.registry.attachAttestation({
      publication_urn: input.publication_urn,
      signer: input.signer,
      key_ref: input.key_ref,
      algorithm: input.algorithm,
      envelope: input.envelope,
      ...(input.predicate_type ? { predicate_type: input.predicate_type } : {}),
      ...(input.note ? { note: input.note } : {}),
    });
  }

  async listAttestations(input: { skill_key: string; version: number }) {
    const version = await this.registry.getSkillVersion(input);
    if (!version) return null;
    return await this.registry.listAttestations({ publication_urn: version.skill_version.urn });
  }

  async createDraft(input: { skill_key: string } & CreateSkillDraftInput) {
    return await this.registry.createSkillDraft({
      skill_key: input.skill_key,
      artifact: {
        content: input.artifact.content,
        encoding: input.artifact.encoding,
        ...(input.artifact.media_type ? { media_type: input.artifact.media_type } : {}),
        ...(input.artifact.original_path ? { original_path: input.artifact.original_path } : {}),
      },
      author: input.author,
      ...(input.display_name ? { display_name: input.display_name } : {}),
      ...(input.description ? { description: input.description } : {}),
      ...(input.source_path ? { source_path: input.source_path } : {}),
      ...(input.commit_sha ? { commit_sha: input.commit_sha } : {}),
      ...(input.git_tag ? { git_tag: input.git_tag } : {}),
      ...(input.artifact_signature ? { artifact_signature: input.artifact_signature } : {}),
      ...(input.capability_claims ? { capability_claims: input.capability_claims } : {}),
      ...(input.governance
        ? {
            governance: {
              ...(input.governance.publisher ? { publisher: input.governance.publisher } : {}),
              ...(input.governance.policy_version ? { policy_version: input.governance.policy_version } : {}),
              ...(input.governance.ontology_version ? { ontology_version: input.governance.ontology_version } : {}),
              ...(input.governance.validation_report ? { validation_report: input.governance.validation_report } : {}),
              ...(input.governance.signature_ref ? { signature_ref: input.governance.signature_ref } : {}),
              ...(input.governance.approver ? { approver: input.governance.approver } : {}),
              ...(input.governance.approver_role ? { approver_role: input.governance.approver_role } : {}),
              ...(input.governance.certification_expires_at
                ? { certification_expires_at: input.governance.certification_expires_at }
                : {}),
            },
          }
        : {}),
      ...(input.lineage
        ? {
            lineage: {
              ...(input.lineage.upstream_skill_version_urns
                ? { upstream_skill_version_urns: input.lineage.upstream_skill_version_urns }
                : {}),
              ...(input.lineage.openlineage
                ? {
                    openlineage: {
                      ...(input.lineage.openlineage.job_namespace
                        ? { job_namespace: input.lineage.openlineage.job_namespace }
                        : {}),
                      ...(input.lineage.openlineage.job_name ? { job_name: input.lineage.openlineage.job_name } : {}),
                      ...(input.lineage.openlineage.run_id ? { run_id: input.lineage.openlineage.run_id } : {}),
                      ...(input.lineage.openlineage.event_time
                        ? { event_time: input.lineage.openlineage.event_time }
                        : {}),
                    },
                  }
                : {}),
            },
          }
        : {}),
    });
  }

  async validate(input: { skill_key: string; version: number } & SkillVersionOperationInput) {
    return await this.registry.validateSkillVersion({
      skill_key: input.skill_key,
      version: input.version,
      author: input.author,
      ...(input.note ? { note: input.note } : {}),
      ...(input.governance ? { governance: compactGovernanceInput(input.governance) } : {}),
    });
  }

  async publish(input: { skill_key: string; version: number } & SkillVersionOperationInput) {
    return await this.registry.publishSkillVersion({
      skill_key: input.skill_key,
      version: input.version,
      author: input.author,
      ...(input.note ? { note: input.note } : {}),
      ...(input.governance ? { governance: compactGovernanceInput(input.governance) } : {}),
      ...(input.prepared_publication_urn ? { prepared_publication_urn: input.prepared_publication_urn } : {}),
      ...(input.signatures
        ? { signatures: input.signatures.map(compactDetachedSignatureInput) }
        : {}),
    });
  }

  async preparePublication(input: { skill_key: string; version: number } & SkillVersionOperationInput) {
    return await this.registry.prepareSkillPublication({
      skill_key: input.skill_key,
      version: input.version,
      author: input.author,
      ...(input.note ? { note: input.note } : {}),
      ...(input.governance ? { governance: compactGovernanceInput(input.governance) } : {}),
    });
  }

  async promote(input: { skill_key: string; version: number } & SkillVersionOperationInput) {
    return await this.registry.promoteSkillVersion({
      skill_key: input.skill_key,
      version: input.version,
      author: input.author,
      ...(input.note ? { note: input.note } : {}),
      ...(input.governance ? { governance: compactGovernanceInput(input.governance) } : {}),
    });
  }

  async deprecate(input: { skill_key: string; version: number } & SkillVersionOperationInput) {
    return await this.registry.deprecateSkillVersion({
      skill_key: input.skill_key,
      version: input.version,
      author: input.author,
      ...(input.note ? { note: input.note } : {}),
      ...(input.governance ? { governance: compactGovernanceInput(input.governance) } : {}),
    });
  }

  async certify(input: { skill_key: string; version: number } & SkillVersionOperationInput) {
    return await this.registry.certifySkillVersion({
      skill_key: input.skill_key,
      version: input.version,
      author: input.author,
      ...(input.note ? { note: input.note } : {}),
      ...(input.governance ? { governance: compactGovernanceInput(input.governance) } : {}),
    });
  }

  async revoke(input: { skill_key: string; version: number } & SkillVersionOperationInput) {
    return await this.registry.revokeSkillVersion({
      skill_key: input.skill_key,
      version: input.version,
      author: input.author,
      ...(input.note ? { note: input.note } : {}),
      ...(input.governance ? { governance: compactGovernanceInput(input.governance) } : {}),
    });
  }

  async review(input: { skill_key: string; version: number; decision: 'approve' | 'reject'; author: string; review_role?: string | undefined; note?: string | undefined }) {
    return await this.registry.reviewSkillVersion({
      skill_key: input.skill_key,
      version: input.version,
      author: input.author,
      decision: input.decision,
      ...(input.review_role ? { review_role: input.review_role } : {}),
      ...(input.note ? { note: input.note } : {}),
    });
  }

  async archive(input: { skill_key: string; version: number } & SkillVersionOperationInput) {
    return await this.registry.archiveSkillVersion({
      skill_key: input.skill_key,
      version: input.version,
      author: input.author,
      ...(input.note ? { note: input.note } : {}),
      ...(input.governance ? { governance: compactGovernanceInput(input.governance) } : {}),
    });
  }
}

function compactGovernanceInput(input: NonNullable<CreateSkillDraftInput['governance']>) {
  return {
    ...(input.publisher ? { publisher: input.publisher } : {}),
    ...(input.policy_version ? { policy_version: input.policy_version } : {}),
    ...(input.ontology_version ? { ontology_version: input.ontology_version } : {}),
    ...(input.validation_report ? { validation_report: input.validation_report } : {}),
    ...(input.signature_ref ? { signature_ref: input.signature_ref } : {}),
    ...(input.approver ? { approver: input.approver } : {}),
    ...(input.approver_role ? { approver_role: input.approver_role } : {}),
    ...(input.certification_expires_at ? { certification_expires_at: input.certification_expires_at } : {}),
  };
}

function compactDetachedSignatureInput(
  input: NonNullable<SkillVersionOperationInput['signatures']>[number],
) {
  return {
    signer: input.signer,
    ...(input.key_ref ? { key_ref: input.key_ref } : {}),
    ...(input.algorithm ? { algorithm: input.algorithm } : {}),
    ...(input.signature ? { signature: input.signature } : {}),
    ...(input.keyless_bundle ? { keyless_bundle: input.keyless_bundle } : {}),
    ...(input.signed_payload ? { signed_payload: input.signed_payload } : {}),
    ...(input.transparency_log_ref ? { transparency_log_ref: input.transparency_log_ref } : {}),
    ...(input.inclusion_proof_ref ? { inclusion_proof_ref: input.inclusion_proof_ref } : {}),
    ...(input.inclusion_proof
      ? {
          inclusion_proof: {
            log_id: input.inclusion_proof.log_id,
            tree_size: input.inclusion_proof.tree_size,
            leaf_index: input.inclusion_proof.leaf_index,
            root_hash: input.inclusion_proof.root_hash,
            proof_hashes: input.inclusion_proof.proof_hashes,
            checkpoint_body: input.inclusion_proof.checkpoint_body,
            checkpoint_signature: input.inclusion_proof.checkpoint_signature,
            ...(input.inclusion_proof.transparency_log_ref
              ? { transparency_log_ref: input.inclusion_proof.transparency_log_ref }
              : {}),
          },
        }
      : {}),
  };
}
