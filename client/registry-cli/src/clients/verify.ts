import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';

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

// Mirrors the algorithms accepted by the registry core so operator verification
// reproduces the server verdict locally.
export function verifyDetachedSignature(input: {
  algorithm: string;
  publicKeyPem: string;
  message: string | Uint8Array;
  signature: string;
}): boolean {
  try {
    const key = createPublicKey(input.publicKeyPem);
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

export type DetachedSignatureVerdict = {
  key_ref: string;
  algorithm: string;
  signed_payload: 'canonical_json' | 'canonical_rdf';
  digest_matches: boolean;
  signature_valid: boolean;
};

export type EnvelopeVerdict = {
  canonical_json_sha256_matches: boolean;
  signatures: DetachedSignatureVerdict[];
  all_signatures_valid: boolean;
};

export function verifyEnvelopeSignatures(input: {
  envelope: {
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
  canonicalRdfBytes?: Uint8Array | undefined;
  resolvePublicKey: (keyRef: string) => string | undefined;
}): EnvelopeVerdict {
  const canonical_json_sha256_matches =
    sha256Hex(Buffer.from(input.envelope.canonical_json, 'utf8')) === input.envelope.canonical_json_sha256;

  const signatures: DetachedSignatureVerdict[] = input.envelope.detached_signatures.map((signature) => {
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
    signatures,
    all_signatures_valid: signatures.every((signature) => signature.signature_valid),
  };
}
