import type { RegistryService } from '../../../../registry/application/ports/registry-service.js';
import type { CreateAgentDraftInput, AgentVersionOperationInput } from '../../contracts/agents/lifecycle.js';

export class AgentLifecycleUseCase {
  constructor(private readonly registry: RegistryService) {}

  async createDraft(input: { agent_key: string } & CreateAgentDraftInput) {
    return await this.registry.createAgentDraft({
      agent_key: input.agent_key,
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
      ...(input.skill_refs
        ? {
            skill_refs: input.skill_refs.map((ref) => ({
              ...(ref.skill_urn ? { skill_urn: ref.skill_urn } : {}),
              ...(ref.skill_key ? { skill_key: ref.skill_key } : {}),
            })),
          }
        : {}),
      ...(input.governance ? { governance: compactGovernanceInput(input.governance) } : {}),
    });
  }

  async validate(input: { agent_key: string; version: number } & AgentVersionOperationInput) {
    return await this.registry.validateAgentVersion({
      agent_key: input.agent_key,
      version: input.version,
      author: input.author,
      ...(input.note ? { note: input.note } : {}),
      ...(input.governance ? { governance: compactGovernanceInput(input.governance) } : {}),
    });
  }

  async revalidate(input: { agent_key: string; version: number } & AgentVersionOperationInput) {
    return await this.registry.revalidateAgentVersion({
      agent_key: input.agent_key,
      version: input.version,
      author: input.author,
      ...(input.note ? { note: input.note } : {}),
    });
  }

  async publish(input: { agent_key: string; version: number } & AgentVersionOperationInput) {
    return await this.registry.publishAgentVersion({
      agent_key: input.agent_key,
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

  async preparePublication(input: { agent_key: string; version: number } & AgentVersionOperationInput) {
    return await this.registry.prepareAgentPublication({
      agent_key: input.agent_key,
      version: input.version,
      author: input.author,
      ...(input.note ? { note: input.note } : {}),
      ...(input.governance ? { governance: compactGovernanceInput(input.governance) } : {}),
    });
  }

  async promote(input: { agent_key: string; version: number } & AgentVersionOperationInput) {
    return await this.registry.promoteAgentVersion({
      agent_key: input.agent_key,
      version: input.version,
      author: input.author,
      ...(input.note ? { note: input.note } : {}),
      ...(input.governance ? { governance: compactGovernanceInput(input.governance) } : {}),
    });
  }

  async deprecate(input: { agent_key: string; version: number } & AgentVersionOperationInput) {
    return await this.registry.deprecateAgentVersion({
      agent_key: input.agent_key,
      version: input.version,
      author: input.author,
      ...(input.note ? { note: input.note } : {}),
      ...(input.governance ? { governance: compactGovernanceInput(input.governance) } : {}),
    });
  }

  async certify(input: { agent_key: string; version: number } & AgentVersionOperationInput) {
    return await this.registry.certifyAgentVersion({
      agent_key: input.agent_key,
      version: input.version,
      author: input.author,
      ...(input.note ? { note: input.note } : {}),
      ...(input.governance ? { governance: compactGovernanceInput(input.governance) } : {}),
    });
  }

  async revoke(input: { agent_key: string; version: number } & AgentVersionOperationInput) {
    return await this.registry.revokeAgentVersion({
      agent_key: input.agent_key,
      version: input.version,
      author: input.author,
      ...(input.note ? { note: input.note } : {}),
      ...(input.governance ? { governance: compactGovernanceInput(input.governance) } : {}),
    });
  }

  async review(input: { agent_key: string; version: number; decision: 'approve' | 'reject'; author: string; review_role?: string | undefined; note?: string | undefined }) {
    return await this.registry.reviewAgentVersion({
      agent_key: input.agent_key,
      version: input.version,
      author: input.author,
      decision: input.decision,
      ...(input.review_role ? { review_role: input.review_role } : {}),
      ...(input.note ? { note: input.note } : {}),
    });
  }

  async archive(input: { agent_key: string; version: number } & AgentVersionOperationInput) {
    return await this.registry.archiveAgentVersion({
      agent_key: input.agent_key,
      version: input.version,
      author: input.author,
      ...(input.note ? { note: input.note } : {}),
      ...(input.governance ? { governance: compactGovernanceInput(input.governance) } : {}),
    });
  }
}

function compactGovernanceInput(input: NonNullable<CreateAgentDraftInput['governance']>) {
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
  input: NonNullable<AgentVersionOperationInput['signatures']>[number],
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
