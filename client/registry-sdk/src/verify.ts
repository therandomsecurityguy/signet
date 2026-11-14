import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';

export type DetachedSignatureCheck = {
  key_ref: string;
  algorithm: string;
  signed_payload: 'canonical_json' | 'canonical_rdf';
  digest_matches: boolean;
  signature_valid: boolean;
};

export type EnvelopeVerificationResult = {
  canonical_json_sha256_matches: boolean;
  canonical_rdf_sha256_matches: boolean | undefined;
  signatures: DetachedSignatureCheck[];
  all_signatures_valid: boolean;
};

type EnvelopeForVerification = {
  canonical_json: string;
  canonical_json_sha256: string;
  canonical_rdf_sha256?: string | undefined;
  detached_signatures: Array<{
    key_ref: string;
    algorithm: string;
    signed_payload?: 'canonical_json' | 'canonical_rdf' | undefined;
    envelope_sha256: string;
    signature: string;
  }>;
};

export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

function parseSignatureBytes(signature: string): Buffer {
  if (signature.startsWith('base64:')) {
    return Buffer.from(signature.slice('base64:'.length), 'base64');
  }
  if (signature.startsWith('hex:')) {
    return Buffer.from(signature.slice('hex:'.length), 'hex');
  }
  throw new Error('Signature must use a supported encoding prefix such as base64: or hex:.');
}

function normalizePem(pem: string): string {
  return pem.includes('BEGIN') ? pem : Buffer.from(pem, 'base64').toString('utf8');
}

/**
 * Client-side verification of a detached signature over canonical bytes.
 *
 * Mirrors the algorithms accepted by the registry core, so a consumer can
 * reproduce the server's verdict locally instead of trusting it.
 */
export function verifyDetachedSignature(input: {
  algorithm: string;
  publicKeyPem: string;
  message: string | Uint8Array;
  signature: string;
}): boolean {
  try {
    const key = createPublicKey(normalizePem(input.publicKeyPem));
    const signatureBytes = parseSignatureBytes(input.signature);
    const message = typeof input.message === 'string' ? Buffer.from(input.message, 'utf8') : input.message;
    switch (input.algorithm) {
      case 'ed25519':
      case 'ed448':
        return verifySignature(null, message, key, signatureBytes);
      case 'rsa-sha256':
      case 'ecdsa-p256-sha256':
      case 'ecdsa-sha256':
        return verifySignature('sha256', message, key, signatureBytes);
      case 'ecdsa-p384-sha384':
      case 'ecdsa-sha384':
        return verifySignature('sha384', message, key, signatureBytes);
      default:
        return false;
    }
  } catch {
    return false;
  }
}

/**
 * Verifies a publication envelope client-side: the canonical JSON digest is
 * recomputed from the served bytes, and every detached signature is checked
 * for digest match and cryptographic validity against the supplied trusted
 * keys.
 *
 * Canonical-RDF signatures need the projected N-Quads bytes; pass them via
 * `canonicalRdfBytes` (fetch the artifact referenced by
 * `canonical_rdf_artifact_urn` if required) or those checks report a digest
 * mismatch.
 */
export function verifyEnvelopeSignatures(input: {
  envelope: EnvelopeForVerification;
  canonicalRdfBytes?: Uint8Array | undefined;
  resolvePublicKey: (keyRef: string) => string | undefined;
}): EnvelopeVerificationResult {
  const recomputed = sha256Hex(Buffer.from(input.envelope.canonical_json, 'utf8'));
  const canonical_json_sha256_matches = recomputed === input.envelope.canonical_json_sha256;

  const canonical_rdf_sha256_matches =
    input.envelope.canonical_rdf_sha256 !== undefined && input.canonicalRdfBytes !== undefined
      ? sha256Hex(input.canonicalRdfBytes) === input.envelope.canonical_rdf_sha256
      : undefined;

  const signatures: DetachedSignatureCheck[] = input.envelope.detached_signatures.map((signature) => {
    const signedPayload = signature.signed_payload ?? 'canonical_json';
    const expectedDigest =
      signedPayload === 'canonical_rdf' ? input.envelope.canonical_rdf_sha256 : input.envelope.canonical_json_sha256;
    const digest_matches = expectedDigest !== undefined && signature.envelope_sha256 === expectedDigest;
    const message =
      signedPayload === 'canonical_rdf'
        ? input.canonicalRdfBytes
        : Buffer.from(input.envelope.canonical_json, 'utf8');
    const publicKeyPem = message ? input.resolvePublicKey(signature.key_ref) : undefined;
    const signature_valid =
      digest_matches && publicKeyPem !== undefined && message !== undefined
        ? verifyDetachedSignature({
            algorithm: signature.algorithm,
            publicKeyPem,
            message,
            signature: signature.signature,
          })
        : false;
    return {
      key_ref: signature.key_ref,
      algorithm: signature.algorithm,
      signed_payload: signedPayload,
      digest_matches,
      signature_valid,
    };
  });

  return {
    canonical_json_sha256_matches,
    canonical_rdf_sha256_matches,
    signatures,
    all_signatures_valid: signatures.every((signature) => signature.signature_valid),
  };
}

/** RFC 6962 leaf hash: SHA-256(0x00 || payload). */
export function rfc6962LeafHash(payload: Uint8Array): Uint8Array {
  return createHash('sha256').update(Buffer.concat([Buffer.from([0x00]), payload])).digest();
}

function rfc6962NodeHash(left: Uint8Array, right: Uint8Array): Uint8Array {
  return createHash('sha256').update(Buffer.concat([Buffer.from([0x01]), left, right])).digest();
}

/**
 * Verifies an RFC 6962 inclusion proof: the leaf at `leafIndex` in a tree of
 * `treeSize` leaves is committed by `rootHash` given `proofHashes`.
 */
export function verifyRfc6962InclusionProof(input: {
  leafHash: Uint8Array;
  leafIndex: number;
  treeSize: number;
  proofHashes: Uint8Array[];
  rootHash: Uint8Array;
}): boolean {
  if (input.leafIndex < 0 || input.treeSize <= 0 || input.leafIndex >= input.treeSize) {
    return false;
  }
  let fn = input.leafIndex;
  let sn = input.treeSize - 1;
  let root: Uint8Array = input.leafHash;

  for (const proofHash of input.proofHashes) {
    if ((fn & 1) === 1 || fn === sn) {
      root = rfc6962NodeHash(proofHash, root);
      while ((fn & 1) === 0 && fn !== 0) {
        fn >>= 1;
        sn >>= 1;
      }
    } else {
      root = rfc6962NodeHash(root, proofHash);
    }
    fn >>= 1;
    sn >>= 1;
  }

  return Buffer.from(root).equals(Buffer.from(input.rootHash));
}
