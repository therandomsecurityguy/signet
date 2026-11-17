export type CreateResult<T> = {
  value: T;
  created: boolean;
};

export type RegistryLifecycleStatus =
  | 'draft'
  | 'validated'
  | 'rejected'
  | 'published'
  | 'certified'
  | 'deprecated'
  | 'revoked'
  | 'archived';
export type RegistryOperationStatus = 'completed' | 'noop';
export type RegistryOperationKind =
  | 'create_draft'
  | 'validate'
  | 'publish'
  | 'promote'
  | 'deprecate'
  | 'certify'
  | 'revoke'
  | 'archive'
  | 'review';

export type RegistryArtifactInput = {
  content: string;
  encoding: 'utf8' | 'base64';
  media_type?: string;
  original_path?: string;
};

export type RegistrySkillRefInput = {
  skill_urn?: string;
  skill_key?: string;
};

export type RegistryLineageInput = {
  upstream_skill_version_urns?: string[];
  openlineage?: {
    job_namespace?: string;
    job_name?: string;
    run_id?: string;
    event_time?: string;
  };
};

export type RegistryGovernanceInput = {
  publisher?: string;
  policy_version?: string;
  ontology_version?: string;
  validation_report?: string;
  signature_ref?: string;
  approver?: string;
  approver_role?: string;
  revocation_reason?: string;
  certification_expires_at?: string;
};

export type RegistryGovernanceArtifactRef = {
  role: 'policy_package' | 'validation_report' | 'certification_evidence' | 'review_evidence';
  artifact_urn: string;
  sha256?: string;
  transparency_append_intent?: RegistryTransparencyAppendIntentRef;
};

export type RegistryTransparencyAppendIntentRef = {
  log_id: string;
  source_type: 'publication_envelope' | 'governance_event';
  request_id: string;
  request_record_sha256: string;
  s3_uri: string;
  tessera_submission_status?: 'staged_only' | 'submitted';
  tessera_submission_error?: string;
  tessera_entry_index?: number;
  tessera_add_url?: string;
  tessera_checkpoint_url?: string;
  tessera_checkpoint_tree_size?: number;
  tessera_checkpoint_root_hash?: string;
  tessera_checkpoint_note_sha256?: string;
  tessera_checkpoint_artifact_urn?: string;
  bucket?: string;
  key?: string;
};

export type RegistryDetachedSignatureRecord = {
  artifact_urn: string;
  sha256?: string;
  signer: string;
  key_ref: string;
  algorithm: string;
  signed_payload?: 'canonical_json' | 'canonical_rdf';
  signed_at: string;
  envelope_sha256: string;
  signature: string;
  transparency_log_ref?: string;
  inclusion_proof_ref?: string;
  // Keyless (sigstore) signatures record the certificate identity instead of
  // a registered trusted key. The full bundle lives in the signature
  // artifact (CAS); these fields mirror it for display.
  keyless?: {
    identity: string;
    issuer: string;
  };
};

// Candidate publication envelope pinned by a prepare call so a client can
// sign it before the (single) mutating publish request that freezes it.
export type RegistryPreparedPublication = {
  prepared_publication_urn: string;
  publication_urn: string;
  expires_at: string;
  canonical_json: string;
  canonical_json_sha256: string;
  canonicalization_algorithm: string;
  canonical_rdf_sha256?: string;
  canonical_rdf_artifact_urn?: string;
};

export type RegistryTransparencyInclusionProofInput = {
  log_id: string;
  tree_size: number;
  leaf_index: number;
  root_hash: string;
  proof_hashes: string[];
  checkpoint_body: string;
  checkpoint_signature: string;
  transparency_log_ref?: string;
};

export type RegistryTransparencyLogSummary = {
  log_urn: string;
  log_id: string;
  origin: string;
  checkpoint_key_ref: string;
  trust_status?: string;
};

export type RegistryTransparencyWitnessSummary = {
  witness_urn: string;
  witness_id: string;
  key_ref: string;
  trust_status?: string;
};

export type RegistryTransparencyGossipEvent = {
  gossip_event_urn: string;
  log_id: string;
  from_witness_id: string;
  to_witness_id: string;
  checkpoint_artifact_urn: string;
  occurred_at: string;
  event_type: 'checkpoint_gossip';
  note_format?: 'raw_signed_note' | 'normalized_checkpoint';
  parse_strategy?: 'signed_note' | 'checkpoint_body_signature';
  payload_sha256?: string;
  source_channel?: string;
  relayed_by_id?: string;
  relay_hop_count?: number;
  source_checkpoint_occurred_at?: string;
};

export type RegistryTransparencyCheckpointObservation = {
  observation_artifact_urn: string;
  observed_from_type: 'log' | 'witness' | 'distributor' | 'peer';
  observed_from_id: string;
  observed_at: string;
  checkpoint_artifact_urn: string;
  tree_size: number;
  root_hash: string;
  note_format?: 'raw_signed_note' | 'normalized_checkpoint';
  parse_strategy?: 'signed_note' | 'checkpoint_body_signature';
  payload_sha256?: string;
  source_channel?: string;
  observer_id?: string;
  observer_type?: string;
  relay_from_type?: 'log' | 'witness' | 'distributor' | 'peer';
  relay_from_id?: string;
  relay_hop_count?: number;
  source_checkpoint_occurred_at?: string;
};

export type RegistryTransparencyNoteSignature = {
  signature_index: number;
  signature_role: 'checkpoint' | 'cosignature';
  signature: string;
  signer?: string;
  key_hint?: string;
  raw_signature_line?: string;
};

export type RegistryTransparencyCheckpointDetails = {
  checkpoint_artifact_urn: string;
  sha256?: string;
  tree_size: number;
  root_hash: string;
  checkpoint_body: string;
  checkpoint_signature: string;
  checkpoint_signature_valid: boolean;
  occurred_at?: string;
  append_only_verified?: boolean;
  witness_quorum_satisfied?: boolean;
  valid_witness_attestation_count?: number;
  witness_quorum_required?: number;
  note_format?: 'raw_signed_note' | 'normalized_checkpoint';
  signature_count?: number;
  signatures?: RegistryTransparencyNoteSignature[];
  signed_note?: string;
  signed_note_signer?: string;
  signed_note_key_hint?: string;
};

export type RegistryTransparencyCheckpointDisagreement = {
  disagreement_id: string;
  log_id: string;
  kind:
    | 'same_size_different_root'
    | 'inconsistent_chain'
    | 'witness_disagreement'
    | 'witness_equivocation'
    | 'checkpoint_regression'
    | 'quorum_drift';
  left_checkpoint_artifact_urn: string;
  right_checkpoint_artifact_urn: string;
  reason: string;
  occurred_at?: string;
  tree_size?: number;
  source_ids?: string[];
};

export type RegistryTransparencyReconciliationCheck = {
  name: string;
  ok: boolean;
  detail?: string;
};

export type RegistryTransparencyReconciliationOutcome = {
  source_type: 'publication_envelope' | 'governance_event';
  request_id: string;
  request_record_sha256: string;
  s3_uri: string;
  status: 'verified' | 'mismatch' | 'not_submitted' | 'fetch_failed';
  tessera_entry_index?: number;
  tessera_submission_status?: 'staged_only' | 'submitted';
  checks: RegistryTransparencyReconciliationCheck[];
  error?: string;
};

export type RegistryTransparencyReconciliation = {
  publication_urn: string;
  log_id: string;
  reconciled_at: string;
  status: 'verified' | 'mismatch' | 'incomplete';
  evidence_artifact_urn: string;
  evidence_sha256: string;
  outcomes: RegistryTransparencyReconciliationOutcome[];
};

export type RegistryTransparencyLogDetails = {
  transparency_log: {
    urn: string;
    properties: Record<string, unknown>;
  };
  checkpoint_key?: {
    key_urn: string;
    key_ref: string;
  };
  current_checkpoint?: RegistryTransparencyCheckpointDetails;
  checkpoints: RegistryTransparencyCheckpointDetails[];
  witnesses: RegistryTransparencyWitnessSummary[];
  gossip_events: RegistryTransparencyGossipEvent[];
};

export type RegistryTrustedPublicKey = {
  public_key: {
    urn: string;
    properties: Record<string, unknown>;
  };
  artifacts: Array<{
    artifact_urn: string;
    sha256?: string;
  }>;
};

export type RegistryTrustedPublicKeySummary = {
  key_urn: string;
  key_ref: string;
  algorithm: string;
  trust_status?: string;
  owner?: string;
};

export type RegistryTransparencyConsistencyProofInput = {
  previous_tree_size: number;
  previous_root_hash: string;
  proof_hashes: string[];
};

export type RegistryTransparencyWitnessAttestationInput = {
  witness_id: string;
  signature: string;
};

export type CreateTransparencyCheckpointObservationInput = {
  log_id: string;
  checkpoint_body?: string;
  checkpoint_signature?: string;
  signed_note?: string;
  observed_from_type: 'log' | 'witness' | 'distributor' | 'peer';
  observed_from_id: string;
  observed_at?: string;
  source_channel?: string;
  observer_id?: string;
  observer_type?: string;
  relay_from_type?: 'log' | 'witness' | 'distributor' | 'peer';
  relay_from_id?: string;
  relay_hop_count?: number;
  source_checkpoint_occurred_at?: string;
};

export type CreateTransparencyGossipEventInput = {
  log_id: string;
  from_witness_id: string;
  to_witness_id: string;
  checkpoint_artifact_urn: string;
  occurred_at?: string;
  source_channel?: string;
  relayed_by_id?: string;
  relay_hop_count?: number;
  source_checkpoint_occurred_at?: string;
};

export type RegistryAgentSummary = {
  agent_urn: string;
  agent_key: string;
  harness_name?: string;
  display_name?: string;
  description?: string;
  source_path?: string;
};

export type RegistryAgentDetails = {
  agent: {
    urn: string;
    properties: Record<string, unknown>;
  };
  active_version?: RegistryAgentVersionDetails;
  skills: Array<{
    skill_urn: string;
    skill_key?: string;
  }>;
  artifacts: Array<{
    artifact_urn: string;
    sha256?: string;
  }>;
  harnesses: Array<{
    harness_urn: string;
    harness_name?: string;
  }>;
};

export type RegistrySkillSummary = {
  skill_urn: string;
  skill_key: string;
  display_name?: string;
  description?: string;
  source_path?: string;
};

export type RegistrySkillDetails = {
  skill: {
    urn: string;
    properties: Record<string, unknown>;
  };
  active_version?: RegistrySkillVersionDetails;
  artifacts: Array<{
    artifact_urn: string;
    sha256?: string;
  }>;
};

export type RegistryAgentVersionDetails = {
  agent_version: {
    urn: string;
    properties: Record<string, unknown>;
  };
  skills: Array<{
    skill_urn: string;
    skill_key?: string;
  }>;
  artifacts: Array<{
    artifact_urn: string;
    sha256?: string;
  }>;
  harnesses: Array<{
    harness_urn: string;
    harness_name?: string;
  }>;
  governance_artifacts: RegistryGovernanceArtifactRef[];
};

export type RegistrySkillVersionDetails = {
  skill_version: {
    urn: string;
    properties: Record<string, unknown>;
  };
  artifacts: Array<{
    artifact_urn: string;
    sha256?: string;
  }>;
  upstream_versions: Array<{
    skill_version_urn: string;
  }>;
  governance_artifacts: RegistryGovernanceArtifactRef[];
};

export type RegistryTaskDetails = {
  task: {
    urn: string;
    properties: Record<string, unknown>;
  };
  targets: Array<{
    target_urn: string;
  }>;
};

export type RegistryOperationResult<T> = {
  task: RegistryTaskDetails;
  result: T;
};

export type RegistryArtifactDetails = {
  sha256: string;
  size_bytes: number;
  content: string;
  content_truncated: boolean;
  // True when the bytes returned were re-hashed and matched the requested
  // content address. False means the stored object could not be trusted.
  digest_verified: boolean;
  media_type?: string;
};

// Raw byte access for transport surfaces (for example an HTTP download
// endpoint). Text consumers keep using `RegistryArtifactDetails.content`.
export type RegistryArtifactBytes = {
  sha256: string;
  size_bytes: number;
  bytes: Uint8Array;
  digest_verified: boolean;
  media_type?: string;
};

// Publication snapshots that link an artifact, with the revocation signal read
// gates need. `revoked` is true when the snapshot is revoked or carries the
// revoked marker after archival.
export type RegistryArtifactReference = {
  publication_urn: string;
  entity_type: 'SKILL_VERSION' | 'AGENT_VERSION';
  revoked: boolean;
};

// DSSE (Dead Simple Signing Envelope) attestation ingestion. The payload is a
// JSON in-toto statement (for example SLSA provenance or an SPDX document
// predicate); the signature is verified over the DSSE PAE bytes against a
// trusted registry key before the attestation is recorded as evidence.
export type RegistryDsseSignature = {
  keyid?: string | undefined;
  sig: string;
};

export type RegistryDsseEnvelope = {
  payload_type: string;
  payload: string;
  signatures: RegistryDsseSignature[];
};

export type RegistryAttestationInput = {
  publication_urn: string;
  signer: string;
  key_ref: string;
  algorithm: string;
  envelope: RegistryDsseEnvelope;
  predicate_type?: string;
  note?: string;
};

export type RegistryAttestationRecord = {
  artifact_urn: string;
  sha256: string;
  signer: string;
  key_ref: string;
  algorithm: string;
  predicate_type: string;
  signature_valid: boolean;
  // True when the statement's subject digests matched an artifact of this
  // publication. Statements without subjects record false.
  subject_bound: boolean;
  subject_digests: string[];
  attached_at: string;
};

// Threat-intel advisories. A signed advisory document maps to publications by
// exact artifact digest first and by identifiers second; report mode returns
// the affected set, enforce mode also auto-revokes revocable matches with
// actor "threat-intel" and records the advisory as CAS evidence.
export type RegistryAdvisoryDocument = {
  advisory_id: string;
  source: string;
  severity: 'low' | 'moderate' | 'high' | 'critical';
  summary: string;
  published_at?: string;
  references?: string[];
  affected: {
    artifact_sha256?: string[];
    skills?: Array<{ skill_key: string; version?: number }>;
    agents?: Array<{ agent_key: string; version?: number }>;
  };
};

export type RegistryAdvisoryInput = {
  mode?: 'report' | 'enforce';
  advisory: RegistryAdvisoryDocument;
  signer: string;
  key_ref: string;
  algorithm: string;
  signature: string;
};

export type RegistryAdvisoryMatchOutcome = 'revoked' | 'already_revoked' | 'not_revocable' | 'reported';

export type RegistryAdvisoryMatch = {
  publication_urn: string;
  entity_type: 'SKILL_VERSION' | 'AGENT_VERSION';
  logical_key: string;
  version: number;
  matched_by: 'artifact_sha256' | 'identifier';
  status: string;
  outcome: RegistryAdvisoryMatchOutcome;
};

export type RegistryAdvisoryRecord = {
  advisory_urn: string;
  advisory_sha256: string;
  advisory_id: string;
  source: string;
  severity: 'low' | 'moderate' | 'high' | 'critical';
  summary: string;
  published_at?: string;
  references: string[];
  signer: string;
  key_ref: string;
  algorithm: string;
  signature: string;
  signature_valid: boolean;
  mode: 'report' | 'enforce';
  ingested_at: string;
  matches: RegistryAdvisoryMatch[];
};

export type RegistryPublicationEnvelope = {
  publication_urn: string;
  logical_urn: string;
  entity_type: 'AGENT_VERSION' | 'SKILL_VERSION';
  canonical_json: string;
  canonical_json_sha256: string;
  canonicalization_algorithm: 'jcs-rfc8785' | 'json-key-sort-v1';
  // The publication envelope is frozen as a CAS artifact at publish time so
  // the published bytes stay stable while later evidence is attached. These
  // fields reference that frozen artifact (absent for legacy publications).
  publication_envelope_artifact_urn?: string;
  publication_envelope_sha256?: string;
  canonical_rdf_sha256?: string;
  canonical_rdf_artifact_urn?: string;
  published_at?: string;
  publisher?: string;
  policy_version?: string;
  validation_status?: string;
  validation_report?: string;
  signature_ref?: string;
  approved_by?: string;
  approved_role?: string;
  artifacts: Array<{
    artifact_urn: string;
    sha256?: string;
  }>;
  governance_artifacts: RegistryGovernanceArtifactRef[];
  detached_signatures: RegistryDetachedSignatureRecord[];
  provenance_refs?: {
    upstream_version_urns?: string[];
    openlineage?: {
      job_namespace?: string;
      job_name?: string;
      run_id?: string;
      event_time?: string;
    };
  };
  revocation_refs?: {
    revoked_at?: string;
    revoked_by?: string;
    revocation_reason?: string;
  };
  supersession_refs?: {
    superseded_by_version_urn?: string;
  };
  transparency_append_intent?: RegistryTransparencyAppendIntentRef;
};

export type RegistryDetachedSignatureVerification = {
  artifact_urn: string;
  key_ref: string;
  signature_algorithm: string;
  signed_payload: 'canonical_json' | 'canonical_rdf';
  signature_kind: 'trusted_key' | 'keyless';
  envelope_sha256_matches: boolean;
  trusted_public_key_resolved: boolean;
  trusted_public_key_urn?: string;
  cryptographic_verification_passed: boolean;
  keyless?: {
    identity?: string;
    issuer?: string;
    verified: boolean;
    failure_kind?: string;
    error?: string;
    certificate_chain_pem?: string;
    // The moment certificate validity is evaluated against. Bound Rekor
    // entries anchor at their attested integratedTime; otherwise stored
    // keyless records use the registry-witnessed attach time (signed_at),
    // never audit time: Fulcio certificates live minutes.
    validity_evaluated_at?: string;
    tlog?: {
      present: boolean;
      verified: boolean;
      body_bound: boolean;
      integrated_time_verified: boolean;
      log_index?: number;
      integrated_time?: string;
      failure_kind?: string;
      error?: string;
    };
  };
  transparency_log_ref?: string;
  inclusion_proof_ref?: string;
  inclusion_proof_present: boolean;
  trusted_transparency_log_resolved: boolean;
  transparency_log_urn?: string;
  checkpoint_key_ref?: string;
  checkpoint_key_resolved: boolean;
  checkpoint_signature_valid: boolean;
  transparency_proof_resolved: boolean;
  transparency_proof_validated: boolean;
  transparency_verification_status: 'verified' | 'missing' | 'reference_only' | 'mismatch' | 'invalid';
  verification_status:
    | 'verified'
    | 'signature_mismatch'
    | 'missing_trusted_key'
    | 'cryptographic_failure'
    | 'untrusted_certificate'
    | 'expired_certificate'
    | 'identity_policy_failed'
    | 'keyless_not_configured'
    | 'tlog_inclusion_promise_failed'
    | 'tlog_not_configured';
};

export type RegistryTransparencyAppendIntentVerification = {
  source_type: 'publication_envelope' | 'governance_event';
  request_id: string;
  request_record_sha256: string;
  s3_uri: string;
  tessera_submission_status?: 'staged_only' | 'submitted';
  tessera_submission_error?: string;
  tessera_entry_index?: number;
  tessera_add_url?: string;
  tessera_checkpoint_url?: string;
  tessera_checkpoint_tree_size?: number;
  tessera_checkpoint_root_hash?: string;
  tessera_checkpoint_note_sha256?: string;
  tessera_checkpoint_artifact_urn?: string;
  checkpoint_artifact_present: boolean;
  committed_by_checkpoint: boolean;
  verification_status: 'committed' | 'staged_only' | 'submission_failed';
};

export type RegistryReviewInput = {
  decision: 'approve' | 'reject';
  review_role?: string;
};

export type RegistryPendingReviewItem = {
  publication_urn: string;
  entity_type: 'SKILL_VERSION' | 'AGENT_VERSION';
  logical_key: string;
  lifecycle_status: string;
  review_status: string;
  policy_version?: string;
};

export type RegistryCompiledSkillClaim = {
  skill_key?: string;
  display_name?: string;
  description?: string;
  capability_claims: string[];
  interfaces: { inputs: string[]; outputs: string[] };
  constraints: string[];
  warnings: string[];
};

export type RegistryCompileSkillResult = {
  compiled: RegistryCompiledSkillClaim;
  ontology_mapping: {
    ontology_version: string | null;
    ontology_package_resolved: boolean;
    mapped: string[];
    unmapped: string[];
  };
};

export type RegistryDeFactoTermDetails = {
  urn: string;
  term: string;
  status: 'candidate' | 'promoted' | 'rejected';
  first_seen_at: string;
  last_seen_at: string;
  seen_count: number;
  example_publication_urns: string[];
  reviewed_by?: string;
  reviewed_at?: string;
  promoted_into_ontology_version?: string;
};

export type RegistryGovernanceLogState = {
  log_id: string;
  tree_size: number;
  root_hash: string | null;
  updated_at?: string;
  leaves: Array<{
    leaf_index: number;
    leaf_hash: string;
    event_artifact_urn?: string;
  }>;
};

export type RegistryGovernanceLogProof = {
  log_id: string;
  leaf_index: number;
  tree_size: number;
  leaf_hash: string;
  proof_hashes: string[];
  root_hash: string;
  event_artifact_urn?: string;
};

export type RegistryGovernanceLogReplay = {
  log_id: string;
  tree_size: number;
  recorded_root_hash: string | null;
  recomputed_root_hash: string | null;
  consistent: boolean;
};

export type RegistryProvenanceActivity = {
  task_urn: string;
  operation: string;
  status: string;
  occurred_at?: string;
  actor?: string;
  used: Array<{ urn: string; entity_type?: string }>;
  associated_agents: Array<{ urn: string; agent_name?: string; role?: string }>;
};

export type RegistryProvenanceEvidence = {
  /** SHA-256 over the RDFC-1.0 canonical N-Quads of the provenance export. */
  canonical_rdf_sha256: string;
  /** Content-addressed artifact holding the canonical N-Quads (fetch via /v1/artifacts/{sha256}). */
  canonical_rdf_artifact_urn: string;
};

export type RegistryProvenanceSignatureInput = {
  signer: string;
  key_ref: string;
  algorithm: string;
  signature: string;
  /**
   * Optional explicit digest the signature was produced over. When present it
   * must equal the current canonical digest; stale payloads are rejected at
   * attach time (re-fetch the export and re-sign).
   */
  provenance_sha256?: string;
};

export type RegistryProvenanceSignatureRecord = {
  artifact_urn: string;
  sha256?: string;
  signer: string;
  key_ref: string;
  algorithm: string;
  signed_at: string;
  provenance_sha256: string;
  signature: string;
};

export type RegistryProvenanceSignatureVerification = {
  artifact_urn: string;
  signer: string;
  key_ref: string;
  algorithm: string;
  signed_at: string;
  provenance_sha256: string;
  artifact_present: boolean;
  trusted_public_key_resolved: boolean;
  cryptographic_verification_passed: boolean;
  digest_matches_current: boolean;
  /**
   * `valid`: cryptographically verified over an artifact that matches the
   * current export. `stale`: verified, but the provenance has grown since
   * the signature was made (the signed export is still retrievable).
   * `invalid`: missing artifact, unresolvable/revoked key, or bad crypto.
   */
  verdict: 'valid' | 'invalid' | 'stale';
};

export type RegistryReportSignatureInput = {
  /** One of the version's `sg:validatedBy` report artifacts (SHACL report with an RDF export). */
  report_artifact_urn: string;
  signer: string;
  key_ref: string;
  algorithm: string;
  signature: string;
};

export type RegistryReportSignatureRecord = {
  artifact_urn: string;
  sha256?: string;
  signer: string;
  key_ref: string;
  algorithm: string;
  signed_at: string;
  report_artifact_urn: string;
  report_canonical_rdf_sha256: string;
  signature: string;
};

export type RegistryReportSignatureVerification = {
  artifact_urn: string;
  signer: string;
  key_ref: string;
  algorithm: string;
  signed_at: string;
  report_artifact_urn: string;
  report_canonical_rdf_sha256: string;
  /** The target report artifact is retrievable and still declares this digest. */
  report_artifact_present: boolean;
  /** The canonical N-Quads artifact the signature binds is retrievable. */
  canonical_artifact_present: boolean;
  trusted_public_key_resolved: boolean;
  cryptographic_verification_passed: boolean;
  /** Reports are immutable: signatures are valid or invalid, never stale. */
  verdict: 'valid' | 'invalid';
};

export type RegistryPublicationProvenance = {
  entity: { urn: string; entity_type: string };
  derivation_chain: Array<{
    version_urn: string;
    was_derived_from: string[];
    activities: RegistryProvenanceActivity[];
  }>;
  replay: Array<{
    occurred_at?: string;
    operation: string;
    actor?: string;
    version_urn: string;
    status: string;
  }>;
  evidence: RegistryProvenanceEvidence;
  /** Detached signatures over canonical provenance exports (may bind older digests). */
  provenance_signatures: RegistryProvenanceSignatureVerification[];
  /** True when at least one signature exists and none is `invalid` (stale is acceptable). */
  all_provenance_signatures_verified: boolean;
  /** True when at least one signature verifies over exactly the current export. */
  current_provenance_signed: boolean;
};

export type RegistryPublicationVerification = {
  envelope: RegistryPublicationEnvelope;
  canonical_json_sha256_matches: boolean;
  canonical_rdf_sha256_matches: boolean | null;
  // Frozen publication envelope checks. `null` when the publication predates
  // envelope freezing (or the artifact could not be read).
  publication_envelope_artifact_present: boolean;
  publication_envelope_artifact_sha256_matches: boolean | null;
  live_envelope_matches_frozen_artifact: boolean | null;
  // DSSE/in-toto attestations attached via sg:attestedBy (build provenance,
  // SBOMs, scan results). Stored evidence is always signature-valid; the flag
  // aggregates the recorded set for consumers.
  attestations: RegistryAttestationRecord[];
  all_attestation_signatures_valid: boolean;
  all_detached_signatures_match_envelope: boolean;
  all_detached_signatures_resolve_trusted_key: boolean;
  all_detached_signatures_verify_cryptographically: boolean;
  all_detached_signatures_verified: boolean;
  all_detached_signatures_have_inclusion_proof: boolean;
  all_detached_signatures_validate_transparency_proof: boolean;
  signature_checks: RegistryDetachedSignatureVerification[];
  publication_append_intent?: RegistryTransparencyAppendIntentVerification;
  governance_append_intents: RegistryTransparencyAppendIntentVerification[];
  append_intent_verification_status: 'not_configured' | 'staged_only' | 'submission_failed' | 'partial' | 'committed';
  transparency_verification_status: 'verified' | 'missing' | 'reference_only' | 'mismatch' | 'invalid';
  verification_status:
    | 'verified'
    | 'digest_mismatch'
    | 'signature_mismatch'
    | 'missing_trusted_key'
    | 'cryptographic_failure'
    | 'untrusted_certificate'
    | 'expired_certificate'
    | 'identity_policy_failed'
    | 'keyless_not_configured'
    | 'tlog_inclusion_promise_failed'
    | 'tlog_not_configured';
};

export type CreateAgentInput = {
  agent_key: string;
  harness_name?: string;
  display_name?: string;
  description?: string;
  source_path?: string;
  artifact?: RegistryArtifactInput;
  skill_refs?: RegistrySkillRefInput[];
  governance?: RegistryGovernanceInput;
};

export type CreateSkillInput = {
  skill_key: string;
  display_name?: string;
  description?: string;
  source_path?: string;
  artifact?: RegistryArtifactInput;
};

export type CreateSkillDraftInput = {
  skill_key: string;
  artifact: RegistryArtifactInput;
  author: string;
  display_name?: string;
  description?: string;
  source_path?: string;
  commit_sha?: string;
  git_tag?: string;
  artifact_signature?: string;
  capability_claims?: string[];
  lineage?: RegistryLineageInput;
  governance?: RegistryGovernanceInput;
};

export type SkillVersionOperationInput = {
  skill_key: string;
  version: number;
  author: string;
  note?: string;
  governance?: RegistryGovernanceInput;
  // Single-request sign-then-publish: publish against the candidate envelope
  // pinned by prepareSkillPublication, optionally attaching client signatures
  // that must verify over exactly that envelope. Signatures are only accepted
  // together with a prepared publication.
  prepared_publication_urn?: string;
  signatures?: RegistryDetachedSignatureInput[];
};

export type CreateAgentDraftInput = {
  agent_key: string;
  artifact: RegistryArtifactInput;
  author: string;
  display_name?: string;
  description?: string;
  source_path?: string;
  commit_sha?: string;
  git_tag?: string;
  artifact_signature?: string;
  capability_claims?: string[];
  skill_refs?: RegistrySkillRefInput[];
  governance?: RegistryGovernanceInput;
};

export type AgentVersionOperationInput = {
  agent_key: string;
  version: number;
  author: string;
  note?: string;
  governance?: RegistryGovernanceInput;
  // Single-request sign-then-publish (see SkillVersionOperationInput).
  prepared_publication_urn?: string;
  signatures?: RegistryDetachedSignatureInput[];
};

export type RegistryDetachedSignatureInput = {
  signer: string;
  // Trusted-key signatures carry key_ref/algorithm/signature; keyless
  // (sigstore) signatures carry a bundle instead and let the registry derive
  // the identity and signature material from the certificate.
  key_ref?: string;
  algorithm?: string;
  signature?: string;
  keyless_bundle?: unknown;
  signed_payload?: 'canonical_json' | 'canonical_rdf';
  transparency_log_ref?: string;
  inclusion_proof_ref?: string;
  inclusion_proof?: RegistryTransparencyInclusionProofInput;
};

export type CreateTrustedPublicKeyInput = {
  key_ref: string;
  algorithm: string;
  public_key_pem: string;
  owner?: string;
  trust_scope?: string;
  valid_from?: string;
  valid_to?: string;
  transparency_log_ref?: string;
  inclusion_proof_ref?: string;
  supersedes_key_ref?: string;
};

export type RevokeTrustedPublicKeyInput = {
  key_ref: string;
  author: string;
  reason?: string;
};

export type PolicyShapesFormat = 'legacy-json-v1' | 'shacl-turtle';

export type CreatePolicyPackageInput = {
  policy_version: string;
  author: string;
  /** Legacy JSON shape document, or authored SHACL Turtle when shapes_format is "shacl-turtle". */
  shapes: unknown;
  /** Authored W3C SHACL Turtle; omit for the legacy JSON shape document format. */
  shapes_format?: 'shacl-turtle';
  description?: string;
  /**
   * Policy lifecycle gates. Legacy JSON documents carry these inside the
   * shape document; for Turtle policies they are envelope metadata (SHACL
   * has no place for lifecycle gates). Top-level gates are rejected for
   * legacy documents.
   */
  require_human_review?: boolean;
  require_validation?: boolean;
  require_signature?: boolean;
  require_trusted_publisher?: boolean;
  require_build_provenance?: boolean;
  require_sbom?: boolean;
};

export type RegistryPolicyPackageDetails = {
  artifact_urn: string;
  sha256: string;
  policy_version: string;
  created_by: string;
  created_at: string;
  description?: string;
  shapes_format: PolicyShapesFormat;
  shapes: unknown;
};

export type OntologyPackageFormat = 'legacy-json-v1' | 'owl-turtle';

export type CreateOntologyPackageInput = {
  ontology_version: string;
  author: string;
  /** Legacy JSON ontology document, or authored OWL Turtle when ontology_format is "owl-turtle". */
  ontology: unknown;
  /** Authored OWL Turtle ontology package; omit for the legacy JSON format. */
  ontology_format?: 'owl-turtle';
  /** Required with the OWL format (the registry kind is envelope metadata there). */
  ontology_kind?: 'registry_shape' | 'skill_area';
  description?: string;
};

export type RegistryOntologyPackageDetails = {
  artifact_urn: string;
  sha256: string;
  ontology_version: string;
  ontology_kind: 'registry_shape' | 'skill_area';
  ontology_format: OntologyPackageFormat;
  /** RDFC-1.0 canonical digest over the ontology's semantic projection (format-independent). */
  canonical_rdf_sha256: string;
  canonical_rdf_artifact_urn: string;
  created_by: string;
  created_at: string;
  description?: string;
  ontology: unknown;
};

export type CreateTransparencyLogInput = {
  log_id: string;
  origin: string;
  checkpoint_key_ref: string;
  log_type?: string;
  trust_scope?: string;
  valid_from?: string;
  valid_to?: string;
  witness_quorum?: number;
};

export type CreateTransparencyWitnessInput = {
  log_id: string;
  witness_id: string;
  key_ref: string;
  witness_type?: string;
  valid_from?: string;
  valid_to?: string;
};

export type CreateTransparencyCheckpointInput = {
  log_id: string;
  checkpoint_body?: string;
  checkpoint_signature?: string;
  signed_note?: string;
  consistency_proof?: RegistryTransparencyConsistencyProofInput;
  witness_attestations?: RegistryTransparencyWitnessAttestationInput[];
  transparency_log_ref?: string;
};

export type RegistryTransparencyLogVerification = {
  transparency_log: RegistryTransparencyLogDetails;
  checkpoint_signature_valid: boolean;
  checkpoint_consistency_verified: boolean;
  trusted_checkpoint_key_resolved: boolean;
  witness_quorum_required: number;
  witness_quorum_met: boolean;
  witness_checks: Array<{
    witness_id: string;
    trusted_witness_resolved: boolean;
    trusted_key_resolved: boolean;
    signature_valid: boolean;
    verification_status: 'verified' | 'missing_witness' | 'missing_key' | 'cryptographic_failure';
  }>;
  verification_status:
    | 'verified'
    | 'missing_checkpoint'
    | 'missing_checkpoint_key'
    | 'checkpoint_signature_invalid'
    | 'consistency_failure'
    | 'witness_quorum_unmet';
  checkpoint_history: RegistryTransparencyCheckpointDetails[];
  observations: RegistryTransparencyCheckpointObservation[];
  disagreements: RegistryTransparencyCheckpointDisagreement[];
  gossip_events: RegistryTransparencyGossipEvent[];
};

export type RegistryTransparencyTimelineEvent = {
  event_id: string;
  kind: 'checkpoint' | 'observation' | 'witness_attestation' | 'gossip' | 'disagreement';
  occurred_at: string;
  summary: string;
  related_urns: string[];
};

export interface RegistryService {
  listTrustedPublicKeys(input: {
    limit?: number;
    offset?: number;
  }): Promise<{ public_keys: RegistryTrustedPublicKeySummary[] }>;
  getTrustedPublicKey(input: { key_ref: string }): Promise<RegistryTrustedPublicKey | null>;
  createTrustedPublicKey(input: CreateTrustedPublicKeyInput): Promise<CreateResult<RegistryTrustedPublicKey>>;
  revokeTrustedPublicKey(input: RevokeTrustedPublicKeyInput): Promise<RegistryTrustedPublicKey>;

  createPolicyPackage(input: CreatePolicyPackageInput): Promise<CreateResult<RegistryPolicyPackageDetails>>;
  listPolicyPackages(): Promise<{ policy_packages: RegistryPolicyPackageDetails[] }>;
  getPolicyPackage(input: { policy_version: string }): Promise<RegistryPolicyPackageDetails | null>;

  createOntologyPackage(input: CreateOntologyPackageInput): Promise<CreateResult<RegistryOntologyPackageDetails>>;
  listOntologyPackages(): Promise<{ ontology_packages: RegistryOntologyPackageDetails[] }>;
  getOntologyPackage(input: { ontology_version: string }): Promise<RegistryOntologyPackageDetails | null>;

  listTransparencyLogs(input: {
    limit?: number;
    offset?: number;
  }): Promise<{ transparency_logs: RegistryTransparencyLogSummary[] }>;
  getTransparencyLog(input: { log_id: string }): Promise<RegistryTransparencyLogDetails | null>;
  createTransparencyLog(input: CreateTransparencyLogInput): Promise<CreateResult<RegistryTransparencyLogDetails>>;
  createTransparencyWitness(input: CreateTransparencyWitnessInput): Promise<CreateResult<RegistryTransparencyLogDetails>>;
  createTransparencyCheckpoint(input: CreateTransparencyCheckpointInput): Promise<RegistryTransparencyCheckpointDetails>;
  createTransparencyCheckpointObservation(
    input: CreateTransparencyCheckpointObservationInput,
  ): Promise<RegistryTransparencyCheckpointObservation>;
  createTransparencyGossipEvent(input: CreateTransparencyGossipEventInput): Promise<RegistryTransparencyGossipEvent>;
  getTransparencyLogVerification(input: { log_id: string }): Promise<RegistryTransparencyLogVerification | null>;
  getTransparencyLogTimeline(input: { log_id: string }): Promise<{ events: RegistryTransparencyTimelineEvent[] } | null>;
  reconcilePublicationTransparency(input: {
    publication_urn: string;
  }): Promise<RegistryTransparencyReconciliation>;

  listAgents(input: {
    harness_name?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ agents: RegistryAgentSummary[] }>;
  getAgentByKey(input: { agent_key: string }): Promise<RegistryAgentDetails | null>;
  getAgentByUrn(input: { agent_urn: string }): Promise<RegistryAgentDetails | null>;
  createAgent(input: CreateAgentInput): Promise<CreateResult<RegistryAgentDetails>>;
  listAgentVersions(input: { agent_key: string }): Promise<{ versions: RegistryAgentVersionDetails[] }>;
  getAgentVersion(input: { agent_key: string; version: number }): Promise<RegistryAgentVersionDetails | null>;
  getActiveAgentVersion(input: { agent_key: string }): Promise<RegistryAgentVersionDetails | null>;
  getAgentPublicationEnvelope(input: { agent_key: string; version: number }): Promise<RegistryPublicationEnvelope | null>;
  getAgentPublicationVerification(input: { agent_key: string; version: number }): Promise<RegistryPublicationVerification | null>;
  createAgentDetachedSignature(
    input: { agent_key: string; version: number } & RegistryDetachedSignatureInput,
  ): Promise<RegistryDetachedSignatureRecord>;
  createAgentProvenanceSignature(
    input: { agent_key: string; version: number } & RegistryProvenanceSignatureInput,
  ): Promise<CreateResult<RegistryProvenanceSignatureRecord>>;
  createAgentReportSignature(
    input: { agent_key: string; version: number } & RegistryReportSignatureInput,
  ): Promise<CreateResult<RegistryReportSignatureRecord>>;
  getPublicationReportSignatures(input: {
    publication_urn: string;
  }): Promise<RegistryReportSignatureVerification[]>;
  createAgentDraft(input: CreateAgentDraftInput): Promise<RegistryOperationResult<RegistryAgentVersionDetails>>;
  validateAgentVersion(input: AgentVersionOperationInput): Promise<RegistryOperationResult<RegistryAgentVersionDetails>>;
  prepareAgentPublication(input: AgentVersionOperationInput): Promise<RegistryPreparedPublication>;
  publishAgentVersion(input: AgentVersionOperationInput): Promise<RegistryOperationResult<RegistryAgentVersionDetails>>;
  promoteAgentVersion(input: AgentVersionOperationInput): Promise<RegistryOperationResult<RegistryAgentVersionDetails>>;
  deprecateAgentVersion(input: AgentVersionOperationInput): Promise<RegistryOperationResult<RegistryAgentVersionDetails>>;
  certifyAgentVersion(input: AgentVersionOperationInput): Promise<RegistryOperationResult<RegistryAgentVersionDetails>>;
  revokeAgentVersion(input: AgentVersionOperationInput): Promise<RegistryOperationResult<RegistryAgentVersionDetails>>;
  archiveAgentVersion(input: AgentVersionOperationInput): Promise<RegistryOperationResult<RegistryAgentVersionDetails>>;

  listSkills(input: { limit?: number; offset?: number }): Promise<{ skills: RegistrySkillSummary[] }>;
  getSkillByKey(input: { skill_key: string }): Promise<RegistrySkillDetails | null>;
  getSkillByUrn(input: { skill_urn: string }): Promise<RegistrySkillDetails | null>;
  createSkill(input: CreateSkillInput): Promise<CreateResult<RegistrySkillDetails>>;
  listSkillVersions(input: { skill_key: string }): Promise<{ versions: RegistrySkillVersionDetails[] }>;
  getSkillVersion(input: { skill_key: string; version: number }): Promise<RegistrySkillVersionDetails | null>;
  getActiveSkillVersion(input: { skill_key: string }): Promise<RegistrySkillVersionDetails | null>;
  getSkillPublicationEnvelope(input: { skill_key: string; version: number }): Promise<RegistryPublicationEnvelope | null>;
  getPublicationProvenance(input: { publication_urn: string }): Promise<RegistryPublicationProvenance | null>;
  getPublicationVerification(input: { publication_urn: string }): Promise<RegistryPublicationVerification | null>;
  compileSkillSource(input: {
    source_type: 'markdown' | 'tool_manifest';
    content: string;
    ontology_version?: string;
  }): Promise<RegistryCompileSkillResult>;
  listDeFactoTerms(input?: { status?: 'candidate' | 'promoted' | 'rejected' }): Promise<{ terms: RegistryDeFactoTermDetails[] }>;
  reviewDeFactoTerm(input: {
    term: string;
    action: 'promote' | 'reject';
    author: string;
    source_ontology_version?: string;
    target_ontology_version?: string;
  }): Promise<RegistryDeFactoTermDetails>;
  getGovernanceLogState(): Promise<RegistryGovernanceLogState>;
  getGovernanceLogProof(input: { leaf_index: number }): Promise<RegistryGovernanceLogProof | null>;
  replayGovernanceLog(): Promise<RegistryGovernanceLogReplay>;
  getSkillPublicationVerification(input: { skill_key: string; version: number }): Promise<RegistryPublicationVerification | null>;
  createSkillDraft(input: CreateSkillDraftInput): Promise<RegistryOperationResult<RegistrySkillVersionDetails>>;
  validateSkillVersion(input: SkillVersionOperationInput): Promise<RegistryOperationResult<RegistrySkillVersionDetails>>;
  prepareSkillPublication(input: SkillVersionOperationInput): Promise<RegistryPreparedPublication>;
  publishSkillVersion(input: SkillVersionOperationInput): Promise<RegistryOperationResult<RegistrySkillVersionDetails>>;
  promoteSkillVersion(input: SkillVersionOperationInput): Promise<RegistryOperationResult<RegistrySkillVersionDetails>>;
  deprecateSkillVersion(input: SkillVersionOperationInput): Promise<RegistryOperationResult<RegistrySkillVersionDetails>>;
  certifySkillVersion(input: SkillVersionOperationInput): Promise<RegistryOperationResult<RegistrySkillVersionDetails>>;
  revokeSkillVersion(input: SkillVersionOperationInput): Promise<RegistryOperationResult<RegistrySkillVersionDetails>>;
  archiveSkillVersion(input: SkillVersionOperationInput): Promise<RegistryOperationResult<RegistrySkillVersionDetails>>;
  reviewSkillVersion(
    input: SkillVersionOperationInput & RegistryReviewInput,
  ): Promise<RegistryOperationResult<RegistrySkillVersionDetails>>;
  reviewAgentVersion(
    input: AgentVersionOperationInput & RegistryReviewInput,
  ): Promise<RegistryOperationResult<RegistryAgentVersionDetails>>;
  listPendingReviews(): Promise<{ pending: RegistryPendingReviewItem[] }>;
  createSkillDetachedSignature(
    input: { skill_key: string; version: number } & RegistryDetachedSignatureInput,
  ): Promise<RegistryDetachedSignatureRecord>;
  createSkillProvenanceSignature(
    input: { skill_key: string; version: number } & RegistryProvenanceSignatureInput,
  ): Promise<CreateResult<RegistryProvenanceSignatureRecord>>;
  createSkillReportSignature(
    input: { skill_key: string; version: number } & RegistryReportSignatureInput,
  ): Promise<CreateResult<RegistryReportSignatureRecord>>;

  getArtifact(input: { sha256?: string; artifact_urn?: string }): Promise<RegistryArtifactDetails | null>;
  getArtifactBytes(input: { sha256?: string; artifact_urn?: string }): Promise<RegistryArtifactBytes | null>;
  getArtifactReferences(input: {
    artifact_urn: string;
  }): Promise<{ references: RegistryArtifactReference[] } | null>;
  attachAttestation(input: RegistryAttestationInput): Promise<{ attestation: RegistryAttestationRecord }>;
  ingestAdvisory(input: RegistryAdvisoryInput): Promise<{ advisory: RegistryAdvisoryRecord }>;
  getAdvisory(input: { advisory_id: string }): Promise<{ advisory: RegistryAdvisoryRecord } | null>;
  listAdvisories(input?: { limit?: number; offset?: number }): Promise<{ advisories: RegistryAdvisoryRecord[] }>;
  listAttestations(input: {
    publication_urn: string;
  }): Promise<{ attestations: RegistryAttestationRecord[] } | null>;
}
