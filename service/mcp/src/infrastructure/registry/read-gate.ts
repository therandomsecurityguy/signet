import type { RegistryService } from '../../../../registry/application/ports/registry-service.js';
import { DomainError } from '../../domain/errors/domain-error.js';
import { ErrorCode } from '../../domain/errors/error-codes.js';

export type RegistryReadGateConfig = {
  deny_revoked: boolean;
  require_verified: boolean;
};

export const REGISTRY_READ_GATE_OFF: RegistryReadGateConfig = {
  deny_revoked: false,
  require_verified: false,
};

// Read gates for the MCP read path. Revocation denial is the default posture
// at the env layer (serving revoked publications unchecked is a bug, not a
// policy); the verification gate is opt-in because how strict verification
// must be is a deployment policy. Verification itself is never gated:
// discovering that a publication is revoked or unverified always has to work.
export class RegistryReadGate {
  constructor(
    private readonly registry: RegistryService,
    private readonly config: RegistryReadGateConfig = REGISTRY_READ_GATE_OFF,
  ) {}

  get enabled(): boolean {
    return this.config.deny_revoked || this.config.require_verified;
  }

  async assertPublicationReadable(input: {
    publication_urn?: string | undefined;
    properties?: Record<string, unknown> | undefined;
  }): Promise<void> {
    if (!this.enabled || !input.publication_urn) return;

    if (this.config.deny_revoked && isRevokedPublication(input.properties)) {
      throw new DomainError({
        code: ErrorCode.RegistryReadDeniedRevoked,
        httpStatus: 403,
        safeMessage: 'Registry read denied: the active publication is revoked.',
      });
    }

    if (this.config.require_verified) {
      const verification = await this.registry.getPublicationVerification({
        publication_urn: input.publication_urn,
      });
      if (!verification || verification.verification_status !== 'verified') {
        throw new DomainError({
          code: ErrorCode.RegistryReadDeniedUnverified,
          httpStatus: 403,
          safeMessage: 'Registry read denied: the active publication did not pass verification.',
        });
      }
    }
  }

  async assertArtifactReadable(input: { artifact_urn: string }): Promise<void> {
    if (!this.enabled) return;

    const references = await this.registry.getArtifactReferences({ artifact_urn: input.artifact_urn });
    // An artifact with no publication references (or an unknown artifact) is
    // not a governed publication artifact; the gates do not apply.
    if (!references || references.references.length === 0) return;

    if (this.config.deny_revoked && references.references.every((reference) => reference.revoked)) {
      throw new DomainError({
        code: ErrorCode.RegistryReadDeniedRevoked,
        httpStatus: 403,
        safeMessage: 'Registry read denied: every publication referencing this artifact is revoked.',
      });
    }

    if (this.config.require_verified) {
      const liveReferences = references.references.filter((reference) => !reference.revoked);
      let verified = false;
      for (const reference of liveReferences) {
        const verification = await this.registry.getPublicationVerification({
          publication_urn: reference.publication_urn,
        });
        if (verification?.verification_status === 'verified') {
          verified = true;
          break;
        }
      }
      if (!verified) {
        throw new DomainError({
          code: ErrorCode.RegistryReadDeniedUnverified,
          httpStatus: 403,
          safeMessage:
            'Registry read denied: no live publication referencing this artifact passed verification.',
        });
      }
    }
  }
}

function isRevokedPublication(properties: Record<string, unknown> | undefined): boolean {
  if (!properties) return false;
  if (properties['revoked'] === true) return true;
  const status = properties['lifecycle_status'] ?? properties['publication_status'] ?? properties['lifecycle_state'];
  return status === 'revoked';
}
