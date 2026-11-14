import { z } from 'zod';

import { AttestationRecordSchema } from './attestations.js';

export const DetachedSignatureRecordSchema = z.object({
  artifact_urn: z.string(),
  sha256: z.string().optional(),
  signer: z.string(),
  keyless: z
    .object({
      identity: z.string(),
      issuer: z.string(),
    })
    .optional(),
  key_ref: z.string(),
  algorithm: z.string(),
  signed_payload: z.enum(['canonical_json', 'canonical_rdf']).optional(),
  signed_at: z.string(),
  envelope_sha256: z.string(),
  signature: z.string(),
  transparency_log_ref: z.string().optional(),
  inclusion_proof_ref: z.string().optional(),
});

export const PublicationEnvelopeSchema = z.object({
  publication_urn: z.string(),
  logical_urn: z.string(),
  entity_type: z.enum(['AGENT_VERSION', 'SKILL_VERSION']),
  canonical_json: z.string(),
  canonical_json_sha256: z.string(),
  canonicalization_algorithm: z.enum(['jcs-rfc8785', 'json-key-sort-v1']),
  publication_envelope_artifact_urn: z.string().optional(),
  publication_envelope_sha256: z.string().optional(),
  canonical_rdf_sha256: z.string().optional(),
  canonical_rdf_artifact_urn: z.string().optional(),
  published_at: z.string().optional(),
  publisher: z.string().optional(),
  policy_version: z.string().optional(),
  validation_status: z.string().optional(),
  validation_report: z.string().optional(),
  signature_ref: z.string().optional(),
  approved_by: z.string().optional(),
  approved_role: z.string().optional(),
  artifacts: z.array(
    z.object({
      artifact_urn: z.string(),
      sha256: z.string().optional(),
    }),
  ),
  governance_artifacts: z.array(
    z.object({
      role: z.enum(['policy_package', 'validation_report', 'certification_evidence', 'review_evidence']),
      artifact_urn: z.string(),
      sha256: z.string().optional(),
      transparency_append_intent: z
        .object({
          log_id: z.string(),
          source_type: z.enum(['publication_envelope', 'governance_event']),
          request_id: z.string(),
          request_record_sha256: z.string(),
          s3_uri: z.string(),
          tessera_submission_status: z.enum(['staged_only', 'submitted']).optional(),
          tessera_submission_error: z.string().optional(),
          tessera_entry_index: z.number().optional(),
          tessera_add_url: z.string().optional(),
          tessera_checkpoint_url: z.string().optional(),
          tessera_checkpoint_tree_size: z.number().optional(),
          tessera_checkpoint_root_hash: z.string().optional(),
          tessera_checkpoint_note_sha256: z.string().optional(),
          tessera_checkpoint_artifact_urn: z.string().optional(),
          bucket: z.string().optional(),
          key: z.string().optional(),
        })
        .optional(),
    }),
  ),
  detached_signatures: z.array(DetachedSignatureRecordSchema),
  provenance_refs: z
    .object({
      upstream_version_urns: z.array(z.string()).optional(),
      openlineage: z
        .object({
          job_namespace: z.string().optional(),
          job_name: z.string().optional(),
          run_id: z.string().optional(),
          event_time: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
  revocation_refs: z
    .object({
      revoked_at: z.string().optional(),
      revoked_by: z.string().optional(),
      revocation_reason: z.string().optional(),
    })
    .optional(),
  supersession_refs: z
    .object({
      superseded_by_version_urn: z.string().optional(),
    })
    .optional(),
  transparency_append_intent: z
    .object({
      log_id: z.string(),
      source_type: z.enum(['publication_envelope', 'governance_event']),
      request_id: z.string(),
      request_record_sha256: z.string(),
      s3_uri: z.string(),
      tessera_submission_status: z.enum(['staged_only', 'submitted']).optional(),
      tessera_submission_error: z.string().optional(),
      tessera_entry_index: z.number().optional(),
      tessera_add_url: z.string().optional(),
      tessera_checkpoint_url: z.string().optional(),
      tessera_checkpoint_tree_size: z.number().optional(),
      tessera_checkpoint_root_hash: z.string().optional(),
      tessera_checkpoint_note_sha256: z.string().optional(),
      tessera_checkpoint_artifact_urn: z.string().optional(),
      bucket: z.string().optional(),
      key: z.string().optional(),
    })
    .optional(),
});

export const CreateDetachedSignatureInputSchema = z
  .object({
    signer: z.string().min(1).max(200),
    // Trusted-key signatures carry key_ref/algorithm/signature; keyless
    // (sigstore) signatures carry a bundle instead.
    key_ref: z.string().min(1).max(500).optional(),
    algorithm: z.string().min(1).max(100).optional(),
    signature: z.string().min(1).max(20_000).optional(),
    keyless_bundle: z.record(z.string(), z.unknown()).optional(),
    signed_payload: z.enum(['canonical_json', 'canonical_rdf']).optional(),
    transparency_log_ref: z.string().min(1).max(1_000).optional(),
    inclusion_proof_ref: z.string().min(1).max(2_000).optional(),
    inclusion_proof: z
      .object({
        log_id: z.string().min(1).max(500),
        tree_size: z.number().int().positive(),
        leaf_index: z.number().int().min(0),
        root_hash: z.string().min(1).max(2_000),
        proof_hashes: z.array(z.string().min(1).max(2_000)).max(10_000),
        checkpoint_body: z.string().min(1).max(20_000),
        checkpoint_signature: z.string().min(1).max(20_000),
        transparency_log_ref: z.string().min(1).max(1_000).optional(),
      })
      .optional(),
  })
  .superRefine((input, ctx) => {
    const keyed = Boolean(input.key_ref && input.algorithm && input.signature);
    if (!keyed && input.keyless_bundle === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'Detached signatures require key_ref, algorithm, and signature, or a keyless_bundle.',
      });
    }
  });

// Candidate publication envelope pinned by a prepare call so a client can
// sign it before the (single) mutating publish request that freezes it.
export const PreparedPublicationSchema = z.object({
  prepared_publication_urn: z.string(),
  publication_urn: z.string(),
  expires_at: z.string(),
  canonical_json: z.string(),
  canonical_json_sha256: z.string(),
  canonicalization_algorithm: z.string(),
  canonical_rdf_sha256: z.string().optional(),
  canonical_rdf_artifact_urn: z.string().optional(),
});

export const PublicationVerificationSchema = z.object({
  envelope: PublicationEnvelopeSchema,
  canonical_json_sha256_matches: z.boolean(),
  canonical_rdf_sha256_matches: z.boolean().nullable(),
  publication_envelope_artifact_present: z.boolean(),
  publication_envelope_artifact_sha256_matches: z.boolean().nullable(),
  live_envelope_matches_frozen_artifact: z.boolean().nullable(),
  attestations: z.array(AttestationRecordSchema),
  all_attestation_signatures_valid: z.boolean(),
  all_detached_signatures_match_envelope: z.boolean(),
  all_detached_signatures_resolve_trusted_key: z.boolean(),
  all_detached_signatures_verify_cryptographically: z.boolean(),
  all_detached_signatures_verified: z.boolean(),
  all_detached_signatures_have_inclusion_proof: z.boolean(),
  signature_checks: z.array(
    z.object({
      artifact_urn: z.string(),
      key_ref: z.string(),
      signature_algorithm: z.string(),
      signed_payload: z.enum(['canonical_json', 'canonical_rdf']),
      signature_kind: z.enum(['trusted_key', 'keyless']),
      envelope_sha256_matches: z.boolean(),
      trusted_public_key_resolved: z.boolean(),
      trusted_public_key_urn: z.string().optional(),
      cryptographic_verification_passed: z.boolean(),
      keyless: z
        .object({
          identity: z.string().optional(),
          issuer: z.string().optional(),
          verified: z.boolean(),
          failure_kind: z.string().optional(),
          error: z.string().optional(),
          certificate_chain_pem: z.string().optional(),
          validity_evaluated_at: z.string().optional(),
          tlog: z
            .object({
              present: z.boolean(),
              verified: z.boolean(),
              body_bound: z.boolean(),
              integrated_time_verified: z.boolean(),
              log_index: z.number().optional(),
              integrated_time: z.string().optional(),
              failure_kind: z.string().optional(),
              error: z.string().optional(),
            })
            .optional(),
        })
        .optional(),
      transparency_log_ref: z.string().optional(),
      inclusion_proof_ref: z.string().optional(),
      inclusion_proof_present: z.boolean(),
      trusted_transparency_log_resolved: z.boolean(),
      transparency_log_urn: z.string().optional(),
      checkpoint_key_ref: z.string().optional(),
      checkpoint_key_resolved: z.boolean(),
      checkpoint_signature_valid: z.boolean(),
      transparency_proof_resolved: z.boolean(),
      transparency_proof_validated: z.boolean(),
      transparency_verification_status: z.enum(['verified', 'missing', 'reference_only', 'mismatch', 'invalid']),
      verification_status: z.enum([
        'verified',
        'signature_mismatch',
        'missing_trusted_key',
        'cryptographic_failure',
        'untrusted_certificate',
        'expired_certificate',
        'identity_policy_failed',
        'keyless_not_configured',
        'tlog_inclusion_promise_failed',
        'tlog_not_configured',
      ]),
    }),
  ),
  all_detached_signatures_validate_transparency_proof: z.boolean(),
  publication_append_intent: z
    .object({
      source_type: z.enum(['publication_envelope', 'governance_event']),
      request_id: z.string(),
      request_record_sha256: z.string(),
      s3_uri: z.string(),
      tessera_submission_status: z.enum(['staged_only', 'submitted']).optional(),
      tessera_submission_error: z.string().optional(),
      tessera_entry_index: z.number().optional(),
      tessera_add_url: z.string().optional(),
      tessera_checkpoint_url: z.string().optional(),
      tessera_checkpoint_tree_size: z.number().optional(),
      tessera_checkpoint_root_hash: z.string().optional(),
      tessera_checkpoint_note_sha256: z.string().optional(),
      tessera_checkpoint_artifact_urn: z.string().optional(),
      checkpoint_artifact_present: z.boolean(),
      committed_by_checkpoint: z.boolean(),
      verification_status: z.enum(['committed', 'staged_only', 'submission_failed']),
    })
    .optional(),
  governance_append_intents: z.array(
    z.object({
      source_type: z.enum(['publication_envelope', 'governance_event']),
      request_id: z.string(),
      request_record_sha256: z.string(),
      s3_uri: z.string(),
      tessera_submission_status: z.enum(['staged_only', 'submitted']).optional(),
      tessera_submission_error: z.string().optional(),
      tessera_entry_index: z.number().optional(),
      tessera_add_url: z.string().optional(),
      tessera_checkpoint_url: z.string().optional(),
      tessera_checkpoint_tree_size: z.number().optional(),
      tessera_checkpoint_root_hash: z.string().optional(),
      tessera_checkpoint_note_sha256: z.string().optional(),
      tessera_checkpoint_artifact_urn: z.string().optional(),
      checkpoint_artifact_present: z.boolean(),
      committed_by_checkpoint: z.boolean(),
      verification_status: z.enum(['committed', 'staged_only', 'submission_failed']),
    }),
  ),
  append_intent_verification_status: z.enum(['not_configured', 'staged_only', 'submission_failed', 'partial', 'committed']),
  transparency_verification_status: z.enum(['verified', 'missing', 'reference_only', 'mismatch', 'invalid']),
  verification_status: z.enum([
    'verified',
    'digest_mismatch',
    'signature_mismatch',
    'missing_trusted_key',
    'cryptographic_failure',
    'untrusted_certificate',
    'expired_certificate',
    'identity_policy_failed',
    'keyless_not_configured',
    'tlog_inclusion_promise_failed',
    'tlog_not_configured',
  ]),
});

export type PublicationEnvelope = z.infer<typeof PublicationEnvelopeSchema>;
export type DetachedSignatureRecord = z.infer<typeof DetachedSignatureRecordSchema>;
export type CreateDetachedSignatureInput = z.infer<typeof CreateDetachedSignatureInputSchema>;
export type PublicationVerification = z.infer<typeof PublicationVerificationSchema>;
