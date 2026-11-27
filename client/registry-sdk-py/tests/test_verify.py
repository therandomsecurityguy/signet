from __future__ import annotations

import base64
import hashlib

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, ed25519

from signet_registry import (
    rfc6962_leaf_hash,
    sha256_hex,
    verify_detached_signature,
    verify_envelope_signatures,
    verify_provenance_signature,
    verify_rfc6962_inclusion_proof,
)


def ed25519_pem() -> tuple[ed25519.Ed25519PrivateKey, str]:
    key = ed25519.Ed25519PrivateKey.generate()
    pem = key.public_key().public_bytes(
        serialization.Encoding.PEM,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode("utf-8")
    return key, pem


def p256_pem() -> tuple[ec.EllipticCurvePrivateKey, str]:
    key = ec.generate_private_key(ec.SECP256R1())
    pem = key.public_key().public_bytes(
        serialization.Encoding.PEM,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode("utf-8")
    return key, pem


def b64_prefixed(signature: bytes) -> str:
    return "base64:" + base64.b64encode(signature).decode("ascii")


def envelope_for(canonical_json: str, signatures: list[dict]) -> dict:
    return {
        "canonical_json": canonical_json,
        "canonical_json_sha256": sha256_hex(canonical_json),
        "detached_signatures": signatures,
    }


def node_hash(left: bytes, right: bytes) -> bytes:
    return hashlib.sha256(b"\x01" + left + right).digest()


class TestDigestHelpers:
    def test_sha256_hex_and_leaf_hash(self):
        assert sha256_hex("abc") == hashlib.sha256(b"abc").hexdigest()
        assert sha256_hex(b"abc") == sha256_hex("abc")
        assert rfc6962_leaf_hash(b"leaf") == hashlib.sha256(b"\x00" + b"leaf").digest()


class TestDetachedSignatures:
    def test_ed25519_roundtrip_and_encodings(self):
        key, pem = ed25519_pem()
        message = "canonical-bytes"
        signature = key.sign(message.encode("utf-8"))
        assert verify_detached_signature(
            algorithm="ed25519",
            public_key_pem=pem,
            message=message,
            signature=b64_prefixed(signature),
        )
        assert verify_detached_signature(
            algorithm="ed25519",
            public_key_pem=pem,
            message=message,
            signature="hex:" + signature.hex(),
        )
        # Base64-of-PEM public keys are normalized like the registry does.
        pem_b64 = base64.b64encode(pem.encode("utf-8")).decode("ascii")
        assert verify_detached_signature(
            algorithm="ed25519",
            public_key_pem=pem_b64,
            message=message,
            signature=b64_prefixed(signature),
        )

    def test_rejections(self):
        key, pem = ed25519_pem()
        other_key, _ = ed25519_pem()
        signature = key.sign(b"message")
        assert not verify_detached_signature(
            algorithm="ed25519",
            public_key_pem=pem,
            message="tampered",
            signature=b64_prefixed(signature),
        )
        assert not verify_detached_signature(
            algorithm="ed25519",
            public_key_pem=pem,
            message="message",
            signature=b64_prefixed(other_key.sign(b"message")),
        )
        assert not verify_detached_signature(
            algorithm="ed25519",
            public_key_pem=pem,
            message="message",
            signature="no-prefix",
        )
        assert not verify_detached_signature(
            algorithm="unknown-alg",
            public_key_pem=pem,
            message="message",
            signature=b64_prefixed(signature),
        )

    def test_ecdsa_and_rsa_variants(self):
        key, pem = p256_pem()
        message = b"canonical-bytes"
        signature = key.sign(message, ec.ECDSA(hashes.SHA256()))
        assert verify_detached_signature(
            algorithm="ecdsa-p256-sha256",
            public_key_pem=pem,
            message=message,
            signature=b64_prefixed(signature),
        )
        assert verify_detached_signature(
            algorithm="ecdsa-sha256",
            public_key_pem=pem,
            message=message,
            signature=b64_prefixed(signature),
        )
        # Wrong key type for the algorithm fails closed.
        ed_key, ed_pem = ed25519_pem()
        assert not verify_detached_signature(
            algorithm="ecdsa-p256-sha256",
            public_key_pem=ed_pem,
            message=message,
            signature=b64_prefixed(ed_key.sign(message)),
        )


class TestEnvelopeVerification:
    def test_happy_path_and_tampering(self):
        key, pem = ed25519_pem()
        canonical = '{"a":1}'
        digest = sha256_hex(canonical)
        envelope = envelope_for(
            canonical,
            [
                {
                    "key_ref": "demo://key",
                    "algorithm": "ed25519",
                    "envelope_sha256": digest,
                    "signature": b64_prefixed(key.sign(canonical.encode("utf-8"))),
                }
            ],
        )
        verdict = verify_envelope_signatures(
            envelope=envelope,
            resolve_public_key=lambda key_ref: pem if key_ref == "demo://key" else None,
        )
        assert verdict.canonical_json_sha256_matches
        assert verdict.all_signatures_valid
        assert verdict.signatures[0].digest_matches
        assert verdict.signatures[0].signature_valid

        tampered = dict(envelope)
        tampered["canonical_json"] = '{"a":2}'
        bad = verify_envelope_signatures(envelope=tampered, resolve_public_key=lambda _ref: pem)
        # The declared digest still matches the signature metadata, but the
        # recomputed digest does not, and the crypto over the served (changed)
        # bytes fails.
        assert not bad.canonical_json_sha256_matches
        assert not bad.all_signatures_valid
        assert not bad.signatures[0].signature_valid

        unknown = verify_envelope_signatures(envelope=envelope, resolve_public_key=lambda _ref: None)
        assert unknown.signatures[0].digest_matches
        assert not unknown.signatures[0].signature_valid
        assert not unknown.all_signatures_valid

    def test_canonical_rdf_variant(self):
        key, pem = ed25519_pem()
        rdf_bytes = b"<urn:s> <urn:p> <urn:o> .\n"
        rdf_digest = sha256_hex(rdf_bytes)
        envelope = {
            "canonical_json": '{"a":1}',
            "canonical_json_sha256": sha256_hex('{"a":1}'),
            "canonical_rdf_sha256": rdf_digest,
            "detached_signatures": [
                {
                    "key_ref": "demo://key",
                    "algorithm": "ed25519",
                    "signed_payload": "canonical_rdf",
                    "envelope_sha256": rdf_digest,
                    "signature": b64_prefixed(key.sign(rdf_bytes)),
                }
            ],
        }

        without_bytes = verify_envelope_signatures(envelope=envelope, resolve_public_key=lambda _ref: pem)
        assert without_bytes.canonical_rdf_sha256_matches is None
        # The signature metadata matches the declared RDF digest, but the
        # crypto cannot be checked without the N-Quads bytes.
        assert without_bytes.signatures[0].digest_matches
        assert not without_bytes.signatures[0].signature_valid
        assert not without_bytes.all_signatures_valid

        with_bytes = verify_envelope_signatures(
            envelope=envelope,
            resolve_public_key=lambda _ref: pem,
            canonical_rdf_bytes=rdf_bytes,
        )
        assert with_bytes.canonical_rdf_sha256_matches is True
        assert with_bytes.all_signatures_valid

        tampered = verify_envelope_signatures(
            envelope=envelope,
            resolve_public_key=lambda _ref: pem,
            canonical_rdf_bytes=b"tampered",
        )
        assert tampered.canonical_rdf_sha256_matches is False
        assert not tampered.all_signatures_valid


class TestProvenanceVerdicts:
    def _signature(self, key: ed25519.Ed25519PrivateKey, digest: str) -> dict:
        return {
            "key_ref": "demo://key",
            "algorithm": "ed25519",
            "provenance_sha256": digest,
            "signature": b64_prefixed(key.sign(b"export")),
        }

    def test_valid_stale_invalid(self):
        key, pem = ed25519_pem()
        digest = sha256_hex(b"export")
        signature = self._signature(key, digest)
        resolve = lambda _ref: pem  # noqa: E731

        valid = verify_provenance_signature(
            canonical_rdf_bytes=b"export",
            signature=signature,
            resolve_public_key=resolve,
            current_provenance_sha256=digest,
        )
        assert valid.verdict == "valid"

        stale = verify_provenance_signature(
            canonical_rdf_bytes=b"export",
            signature=signature,
            resolve_public_key=resolve,
            current_provenance_sha256=sha256_hex(b"grown"),
        )
        assert stale.verdict == "stale"
        assert stale.signature_valid

        invalid = verify_provenance_signature(
            canonical_rdf_bytes=b"tampered",
            signature=signature,
            resolve_public_key=resolve,
        )
        assert invalid.verdict == "invalid"
        assert not invalid.digest_matches


class TestInclusionProofs:
    def test_three_leaf_tree_and_tampering(self):
        leaves = [rfc6962_leaf_hash(f"leaf-{index}".encode("utf-8")) for index in range(3)]
        root = node_hash(node_hash(leaves[0], leaves[1]), leaves[2])

        # Leaf 1 sits under the left subtree: proof is [leaf-0, leaf-2].
        assert verify_rfc6962_inclusion_proof(
            leaf_hash=leaves[1],
            leaf_index=1,
            tree_size=3,
            proof_hashes=[leaves[0], leaves[2]],
            root_hash=root,
        )
        # Leaf 2 is the odd right leaf: proof is [left-subtree-root].
        assert verify_rfc6962_inclusion_proof(
            leaf_hash=leaves[2],
            leaf_index=2,
            tree_size=3,
            proof_hashes=[node_hash(leaves[0], leaves[1])],
            root_hash=root,
        )
        # Swapped proof order fails.
        assert not verify_rfc6962_inclusion_proof(
            leaf_hash=leaves[1],
            leaf_index=1,
            tree_size=3,
            proof_hashes=[leaves[2], leaves[0]],
            root_hash=root,
        )
        # Out-of-range indices fail closed.
        assert not verify_rfc6962_inclusion_proof(
            leaf_hash=leaves[0],
            leaf_index=3,
            tree_size=3,
            proof_hashes=[],
            root_hash=root,
        )
        assert not verify_rfc6962_inclusion_proof(
            leaf_hash=leaves[0],
            leaf_index=0,
            tree_size=0,
            proof_hashes=[],
            root_hash=root,
        )
