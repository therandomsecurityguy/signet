"""Signet registry Python SDK: verify-before-load helpers + a small read client.

Mirrors the TypeScript SDK (``@signet-registry/sdk``) verdict semantics:

    from signet_registry import RegistryClient, verify_envelope_signatures

    client = RegistryClient("http://localhost:3100")
    envelope = ...            # GET /v1/skills/{key}/versions/{v}/publication-envelope
    verdict = verify_envelope_signatures(
        envelope=envelope,
        resolve_public_key=lambda key_ref: pems.get(key_ref),
    )
    artifact = client.fetch_artifact(sha256="...")
    assert artifact.digest_verified
"""

from .client import (
    ArtifactFetch,
    RegistryClient,
    RegistryClientError,
    content_digest_matches,
    parse_artifact_sha256,
)
from .verify import (
    DetachedSignatureCheck,
    EnvelopeVerificationResult,
    ProvenanceSignatureCheck,
    ProvenanceSignatureVerdict,
    rfc6962_leaf_hash,
    sha256_hex,
    verify_detached_signature,
    verify_envelope_signatures,
    verify_provenance_signature,
    verify_rfc6962_inclusion_proof,
)

__all__ = [
    "ArtifactFetch",
    "DetachedSignatureCheck",
    "EnvelopeVerificationResult",
    "ProvenanceSignatureCheck",
    "ProvenanceSignatureVerdict",
    "RegistryClient",
    "RegistryClientError",
    "content_digest_matches",
    "parse_artifact_sha256",
    "rfc6962_leaf_hash",
    "sha256_hex",
    "verify_detached_signature",
    "verify_envelope_signatures",
    "verify_provenance_signature",
    "verify_rfc6962_inclusion_proof",
]
