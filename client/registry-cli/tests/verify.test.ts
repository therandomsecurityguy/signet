import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign as signBytes } from 'node:crypto';

import { sha256Hex, verifyDetachedSignature, verifyEnvelopeSignatures, verifyProvenanceSignature } from '../src/clients/verify.js';

function ed25519() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey,
  };
}

describe('registry-operator verification helpers', () => {
  it('hashes and verifies detached signatures like the registry core', () => {
    const { publicKeyPem, privateKey } = ed25519();
    const message = '{"canonical":true}';
    const signature = `base64:${signBytes(null, Buffer.from(message, 'utf8'), privateKey).toString('base64')}`;

    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(verifyDetachedSignature({ algorithm: 'ed25519', publicKeyPem, message, signature })).toBe(true);
    expect(
      verifyDetachedSignature({ algorithm: 'ed25519', publicKeyPem, message: '{"canonical":false}', signature }),
    ).toBe(false);
    expect(verifyDetachedSignature({ algorithm: 'ed25519', publicKeyPem, message, signature: 'raw' })).toBe(false);
  });

  it('classifies provenance signatures as valid, stale, or invalid', () => {
    const { publicKeyPem, privateKey } = ed25519();
    const canonicalBytes = '<urn:a> <urn:b> <urn:c> .\n';
    const signedDigest = sha256Hex(canonicalBytes);
    const signature = {
      key_ref: 'demo://keys/provenance',
      algorithm: 'ed25519',
      provenance_sha256: signedDigest,
      signature: `base64:${signBytes(null, Buffer.from(canonicalBytes, 'utf8'), privateKey).toString('base64')}`,
    };
    const resolvePublicKey = (keyRef: string) => (keyRef === signature.key_ref ? publicKeyPem : undefined);

    expect(
      verifyProvenanceSignature({
        canonicalRdfBytes: canonicalBytes,
        currentProvenanceSha256: signedDigest,
        signature,
        resolvePublicKey,
      }).verdict,
    ).toBe('valid');

    expect(
      verifyProvenanceSignature({
        canonicalRdfBytes: canonicalBytes,
        currentProvenanceSha256: sha256Hex(`${canonicalBytes}<urn:d> <urn:e> <urn:f> .\n`),
        signature,
        resolvePublicKey,
      }).verdict,
    ).toBe('stale');

    expect(
      verifyProvenanceSignature({
        canonicalRdfBytes: `${canonicalBytes}#tampered`,
        signature,
        resolvePublicKey,
      }).verdict,
    ).toBe('invalid');

    expect(
      verifyProvenanceSignature({
        canonicalRdfBytes: canonicalBytes,
        signature,
        resolvePublicKey: () => undefined,
      }).verdict,
    ).toBe('invalid');
  });

  it('recomputes the envelope digest and verifies signatures locally', () => {
    const { publicKeyPem, privateKey } = ed25519();
    const canonicalJson = '{"a":1}';
    const digest = sha256Hex(canonicalJson);
    const signature = `base64:${signBytes(null, Buffer.from(canonicalJson, 'utf8'), privateKey).toString('base64')}`;
    const envelope = {
      canonical_json: canonicalJson,
      canonical_json_sha256: digest,
      detached_signatures: [
        { key_ref: 'kms://demo/key', algorithm: 'ed25519', envelope_sha256: digest, signature },
      ],
    };

    const verified = verifyEnvelopeSignatures({ envelope, resolvePublicKey: () => publicKeyPem });
    expect(verified.canonical_json_sha256_matches).toBe(true);
    expect(verified.all_signatures_valid).toBe(true);

    const tampered = verifyEnvelopeSignatures({
      envelope: { ...envelope, canonical_json: '{"a":2}' },
      resolvePublicKey: () => publicKeyPem,
    });
    expect(tampered.canonical_json_sha256_matches).toBe(false);
    expect(tampered.signatures[0]).toMatchObject({ signature_valid: false });

    const unsigned = verifyEnvelopeSignatures({
      envelope: { ...envelope, detached_signatures: [] },
      resolvePublicKey: () => publicKeyPem,
    });
    expect(unsigned.all_signatures_valid).toBe(true);
  });
});
