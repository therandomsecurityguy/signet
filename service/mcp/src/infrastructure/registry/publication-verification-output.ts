import type { RegistryPublicationVerification } from '../../../../registry/application/ports/registry-service.js';
import type { RegistryVerifyPublicationOutput } from '../../contracts/tools/registry-verify-publication.js';

// Explicit mapping from the registry core verification payload to the tool
// output: the tool surface stays intentional, and future core fields cannot
// leak into structured content unnoticed. Raw envelope bytes and append-intent
// detail stay on service/api; this tool carries the trust verdicts.
export function toVerifyPublicationOutput(
  verification: RegistryPublicationVerification,
): RegistryVerifyPublicationOutput {
  const { envelope } = verification;
  return {
    publication_urn: envelope.publication_urn,
    logical_urn: envelope.logical_urn,
    entity_type: envelope.entity_type,
    canonical_json_sha256: envelope.canonical_json_sha256,
    canonicalization_algorithm: envelope.canonicalization_algorithm,
    ...(envelope.publication_envelope_artifact_urn
      ? { publication_envelope_artifact_urn: envelope.publication_envelope_artifact_urn }
      : {}),
    ...(envelope.publication_envelope_sha256
      ? { publication_envelope_sha256: envelope.publication_envelope_sha256 }
      : {}),
    canonical_json_sha256_matches: verification.canonical_json_sha256_matches,
    canonical_rdf_sha256_matches: verification.canonical_rdf_sha256_matches,
    publication_envelope_artifact_present: verification.publication_envelope_artifact_present,
    publication_envelope_artifact_sha256_matches: verification.publication_envelope_artifact_sha256_matches,
    live_envelope_matches_frozen_artifact: verification.live_envelope_matches_frozen_artifact,
    all_detached_signatures_match_envelope: verification.all_detached_signatures_match_envelope,
    all_detached_signatures_resolve_trusted_key: verification.all_detached_signatures_resolve_trusted_key,
    all_detached_signatures_verify_cryptographically:
      verification.all_detached_signatures_verify_cryptographically,
    all_detached_signatures_verified: verification.all_detached_signatures_verified,
    all_detached_signatures_have_inclusion_proof: verification.all_detached_signatures_have_inclusion_proof,
    all_detached_signatures_validate_transparency_proof:
      verification.all_detached_signatures_validate_transparency_proof,
    signature_checks: verification.signature_checks.map((check) => ({
      artifact_urn: check.artifact_urn,
      key_ref: check.key_ref,
      signature_algorithm: check.signature_algorithm,
      signed_payload: check.signed_payload,
      signature_kind: check.signature_kind,
      envelope_sha256_matches: check.envelope_sha256_matches,
      trusted_public_key_resolved: check.trusted_public_key_resolved,
      ...(check.trusted_public_key_urn ? { trusted_public_key_urn: check.trusted_public_key_urn } : {}),
      cryptographic_verification_passed: check.cryptographic_verification_passed,
      ...(check.keyless
        ? {
            keyless: {
              ...(check.keyless.identity ? { identity: check.keyless.identity } : {}),
              ...(check.keyless.issuer ? { issuer: check.keyless.issuer } : {}),
              verified: check.keyless.verified,
              ...(check.keyless.failure_kind ? { failure_kind: check.keyless.failure_kind } : {}),
              ...(check.keyless.error ? { error: check.keyless.error } : {}),
              ...(check.keyless.validity_evaluated_at
                ? { validity_evaluated_at: check.keyless.validity_evaluated_at }
                : {}),
            },
          }
        : {}),
      ...(check.transparency_log_ref ? { transparency_log_ref: check.transparency_log_ref } : {}),
      ...(check.inclusion_proof_ref ? { inclusion_proof_ref: check.inclusion_proof_ref } : {}),
      inclusion_proof_present: check.inclusion_proof_present,
      checkpoint_key_resolved: check.checkpoint_key_resolved,
      checkpoint_signature_valid: check.checkpoint_signature_valid,
      transparency_proof_resolved: check.transparency_proof_resolved,
      transparency_proof_validated: check.transparency_proof_validated,
      transparency_verification_status: check.transparency_verification_status,
      verification_status: check.verification_status,
    })),
    append_intent_verification_status: verification.append_intent_verification_status,
    transparency_verification_status: verification.transparency_verification_status,
    attestations: verification.attestations.map((attestation) => ({
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
    all_attestation_signatures_valid: verification.all_attestation_signatures_valid,
    verification_status: verification.verification_status,
  };
}
