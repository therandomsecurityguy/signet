"""Client-side verification helpers for Signet publications.

Mirrors the registry core and the TypeScript SDK (``@signet-registry/sdk``)
so Python consumers can reproduce every verdict locally instead of trusting
the server. No network access happens here — fetch what you need through
:class:`signet_registry.RegistryClient` and pass the bytes in.
"""

from __future__ import annotations

import base64
import hashlib
from dataclasses import dataclass
from typing import Any, Callable, Literal, Mapping, Optional, Sequence, Union

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, ed448, ed25519, padding, rsa

BytesLike = Union[str, bytes]


def sha256_hex(data: BytesLike) -> str:
    """Hex SHA-256 over string (utf-8) or bytes input."""
    payload = data.encode("utf-8") if isinstance(data, str) else data
    return hashlib.sha256(payload).hexdigest()


def rfc6962_leaf_hash(payload: bytes) -> bytes:
    """RFC 6962 leaf hash: SHA-256(0x00 || payload)."""
    return hashlib.sha256(b"\x00" + payload).digest()


def _rfc6962_node_hash(left: bytes, right: bytes) -> bytes:
    return hashlib.sha256(b"\x01" + left + right).digest()


def _parse_signature_bytes(signature: str) -> bytes:
    if signature.startswith("base64:"):
        return base64.b64decode(signature[len("base64:") :])
    if signature.startswith("hex:"):
        return bytes.fromhex(signature[len("hex:") :])
    raise ValueError("Signature must use a supported encoding prefix such as base64: or hex:.")


def _normalize_pem(public_key_pem: str) -> bytes:
    if "BEGIN" in public_key_pem:
        return public_key_pem.encode("utf-8")
    return base64.b64decode(public_key_pem)


def verify_detached_signature(
    *,
    algorithm: str,
    public_key_pem: str,
    message: BytesLike,
    signature: str,
) -> bool:
    """Verify a detached signature over canonical bytes.

    Mirrors the algorithms accepted by the registry core: ed25519/ed448 (no
    pre-hash), rsa-sha256 (PKCS#1 v1.5), and ecdsa p-256/p-384 (DER
    signatures). Any parsing or cryptographic failure returns ``False``.
    """
    try:
        key = serialization.load_pem_public_key(_normalize_pem(public_key_pem))
        signature_bytes = _parse_signature_bytes(signature)
        data = message.encode("utf-8") if isinstance(message, str) else message
        if algorithm in ("ed25519", "ed448"):
            if not isinstance(key, (ed25519.Ed25519PublicKey, ed448.Ed448PublicKey)):
                return False
            key.verify(signature_bytes, data)
            return True
        if algorithm == "rsa-sha256":
            if not isinstance(key, rsa.RSAPublicKey):
                return False
            key.verify(signature_bytes, data, padding.PKCS1v15(), hashes.SHA256())
            return True
        if algorithm in ("ecdsa-p256-sha256", "ecdsa-sha256"):
            if not isinstance(key, ec.EllipticCurvePublicKey):
                return False
            key.verify(signature_bytes, data, ec.ECDSA(hashes.SHA256()))
            return True
        if algorithm in ("ecdsa-p384-sha384", "ecdsa-sha384"):
            if not isinstance(key, ec.EllipticCurvePublicKey):
                return False
            key.verify(signature_bytes, data, ec.ECDSA(hashes.SHA384()))
            return True
        return False
    except Exception:
        return False


@dataclass(frozen=True)
class DetachedSignatureCheck:
    key_ref: str
    algorithm: str
    signed_payload: str  # 'canonical_json' | 'canonical_rdf'
    digest_matches: bool
    signature_valid: bool


@dataclass(frozen=True)
class EnvelopeVerificationResult:
    canonical_json_sha256_matches: bool
    canonical_rdf_sha256_matches: Optional[bool]
    signatures: Sequence[DetachedSignatureCheck]
    all_signatures_valid: bool


def verify_envelope_signatures(
    *,
    envelope: Mapping[str, Any],
    resolve_public_key: Callable[[str], Optional[str]],
    canonical_rdf_bytes: Optional[bytes] = None,
) -> EnvelopeVerificationResult:
    """Verify a publication envelope client-side.

    The canonical JSON digest is recomputed from the served bytes, and every
    detached signature is checked for digest match and cryptographic validity
    against the supplied trusted keys.

    Canonical-RDF signatures need the projected N-Quads bytes; pass them via
    ``canonical_rdf_bytes`` (fetch the artifact referenced by
    ``canonical_rdf_artifact_urn`` if required) or those checks report a
    digest mismatch.
    """
    canonical_json = str(envelope.get("canonical_json") or "")
    canonical_json_sha256 = str(envelope.get("canonical_json_sha256") or "")
    canonical_rdf_sha256 = envelope.get("canonical_rdf_sha256")

    recomputed = sha256_hex(canonical_json.encode("utf-8"))
    canonical_json_sha256_matches = recomputed == canonical_json_sha256

    canonical_rdf_sha256_matches: Optional[bool] = None
    if canonical_rdf_sha256 is not None and canonical_rdf_bytes is not None:
        canonical_rdf_sha256_matches = sha256_hex(canonical_rdf_bytes) == canonical_rdf_sha256

    checks: list[DetachedSignatureCheck] = []
    for signature in envelope.get("detached_signatures") or []:
        signed_payload = signature.get("signed_payload") or "canonical_json"
        expected_digest = canonical_rdf_sha256 if signed_payload == "canonical_rdf" else canonical_json_sha256
        digest_matches = expected_digest is not None and signature.get("envelope_sha256") == expected_digest
        message: Optional[bytes] = (
            canonical_rdf_bytes if signed_payload == "canonical_rdf" else canonical_json.encode("utf-8")
        )
        public_key_pem = resolve_public_key(str(signature.get("key_ref") or "")) if message is not None else None
        signature_valid = bool(
            digest_matches
            and public_key_pem is not None
            and message is not None
            and verify_detached_signature(
                algorithm=str(signature.get("algorithm") or ""),
                public_key_pem=public_key_pem,
                message=message,
                signature=str(signature.get("signature") or ""),
            )
        )
        checks.append(
            DetachedSignatureCheck(
                key_ref=str(signature.get("key_ref") or ""),
                algorithm=str(signature.get("algorithm") or ""),
                signed_payload=str(signed_payload),
                digest_matches=bool(digest_matches),
                signature_valid=signature_valid,
            )
        )

    return EnvelopeVerificationResult(
        canonical_json_sha256_matches=canonical_json_sha256_matches,
        canonical_rdf_sha256_matches=canonical_rdf_sha256_matches,
        signatures=checks,
        all_signatures_valid=all(check.signature_valid for check in checks),
    )


ProvenanceSignatureVerdict = Literal["valid", "invalid", "stale"]


@dataclass(frozen=True)
class ProvenanceSignatureCheck:
    key_ref: str
    algorithm: str
    digest_matches: bool
    signature_valid: bool
    verdict: ProvenanceSignatureVerdict


def verify_provenance_signature(
    *,
    canonical_rdf_bytes: BytesLike,
    signature: Mapping[str, Any],
    resolve_public_key: Callable[[str], Optional[str]],
    current_provenance_sha256: Optional[str] = None,
) -> ProvenanceSignatureCheck:
    """Verify a detached provenance signature and classify its freshness.

    Mirrors the registry's verdict logic: fetch the canonical N-Quads
    artifact the signature binds (``provenance_sha256``, via
    ``/v1/artifacts/{sha256}``), pass those bytes here, and pass the current
    export digest as ``current_provenance_sha256`` to distinguish ``valid``
    from ``stale`` after the provenance has grown.
    """
    bytes_value = canonical_rdf_bytes.encode("utf-8") if isinstance(canonical_rdf_bytes, str) else canonical_rdf_bytes
    digest_matches = sha256_hex(bytes_value) == signature.get("provenance_sha256")
    public_key_pem = resolve_public_key(str(signature.get("key_ref") or ""))
    signature_valid = bool(
        digest_matches
        and public_key_pem is not None
        and verify_detached_signature(
            algorithm=str(signature.get("algorithm") or ""),
            public_key_pem=public_key_pem,
            message=bytes_value,
            signature=str(signature.get("signature") or ""),
        )
    )
    if not digest_matches or not signature_valid:
        verdict = "invalid"
    elif current_provenance_sha256 is not None and signature.get("provenance_sha256") != current_provenance_sha256:
        verdict = "stale"
    else:
        verdict = "valid"
    return ProvenanceSignatureCheck(
        key_ref=str(signature.get("key_ref") or ""),
        algorithm=str(signature.get("algorithm") or ""),
        digest_matches=bool(digest_matches),
        signature_valid=signature_valid,
        verdict=verdict,
    )


def verify_rfc6962_inclusion_proof(
    *,
    leaf_hash: bytes,
    leaf_index: int,
    tree_size: int,
    proof_hashes: Sequence[bytes],
    root_hash: bytes,
) -> bool:
    """Verify an RFC 6962 inclusion proof.

    The leaf at ``leaf_index`` in a tree of ``tree_size`` leaves is committed
    by ``root_hash`` given ``proof_hashes``.
    """
    if leaf_index < 0 or tree_size <= 0 or leaf_index >= tree_size:
        return False
    fn = leaf_index
    sn = tree_size - 1
    root = leaf_hash

    for proof_hash in proof_hashes:
        if (fn & 1) == 1 or fn == sn:
            root = _rfc6962_node_hash(proof_hash, root)
            while (fn & 1) == 0 and fn != 0:
                fn >>= 1
                sn >>= 1
        else:
            root = _rfc6962_node_hash(root, proof_hash)
        fn >>= 1
        sn >>= 1

    return root == root_hash
