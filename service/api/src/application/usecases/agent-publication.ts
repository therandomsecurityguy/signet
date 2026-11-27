import type { RegistryService } from '../../../../registry/application/ports/registry-service.js';
import { agentVersionUrn } from '../../../../registry/domain/signet/db/graph/freeform/registry/urn.js';

export class AgentPublicationUseCase {
  constructor(private readonly registry: RegistryService) {}

  async listVersions(input: { agent_key: string }) {
    return await this.registry.listAgentVersions(input);
  }

  async getActive(input: { agent_key: string }) {
    return await this.registry.getActiveAgentVersion(input);
  }

  async getVersion(input: { agent_key: string; version: number }) {
    return await this.registry.getAgentVersion(input);
  }

  async getPublicationEnvelope(input: { agent_key: string; version: number }) {
    return await this.registry.getAgentPublicationEnvelope(input);
  }

  async getPublicationVerification(input: { agent_key: string; version: number }) {
    const verification = await this.registry.getAgentPublicationVerification(input);
    if (verification) {
      // Aggregate verify-encounter signal (build plan 3.1). Best-effort.
      try {
        await this.registry.recordUsageSignal({
          publication_urn: agentVersionUrn(input.agent_key, input.version),
          signal: verification.verification_status === 'verified' ? 'verify' : 'verify_failure',
        });
      } catch {
        // Ignored by design.
      }
    }
    return verification;
  }

  async getGateHints(input: { agent_key: string; version: number }) {
    return await this.registry.getPublicationGateHints({
      publication_urn: agentVersionUrn(input.agent_key, input.version),
    });
  }

  async getProvenance(input: { agent_key: string; version: number }) {
    const version = await this.registry.getAgentVersion(input);
    if (!version) return null;
    return await this.registry.getPublicationProvenance({ publication_urn: version.agent_version.urn });
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

  async listAttestations(input: { agent_key: string; version: number }) {
    const version = await this.registry.getAgentVersion(input);
    if (!version) return null;
    return await this.registry.listAttestations({ publication_urn: version.agent_version.urn });
  }

  async createDetachedSignature(input: {
    agent_key: string;
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
    return await this.registry.createAgentDetachedSignature(input);
  }

  async createProvenanceSignature(input: {
    agent_key: string;
    version: number;
    signer: string;
    key_ref: string;
    algorithm: string;
    signature: string;
    provenance_sha256?: string;
  }) {
    return await this.registry.createAgentProvenanceSignature(input);
  }

  async createReportSignature(input: {
    agent_key: string;
    version: number;
    report_artifact_urn: string;
    signer: string;
    key_ref: string;
    algorithm: string;
    signature: string;
  }) {
    return await this.registry.createAgentReportSignature(input);
  }

  async getReportSignatures(input: { agent_key: string; version: number }) {
    const version = await this.registry.getAgentVersion(input);
    if (!version) return null;
    return {
      report_signatures: await this.registry.getPublicationReportSignatures({
        publication_urn: version.agent_version.urn,
      }),
    };
  }
}
