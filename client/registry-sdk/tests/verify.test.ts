import { describe, expect, it } from 'vitest';
import { createHash, generateKeyPairSync, sign as signBytes } from 'node:crypto';

import {
  RegistryClient,
  RegistryClientError,
  rfc6962LeafHash,
  sha256Hex,
  verifyDetachedSignature,
  verifyEnvelopeSignatures,
  verifyProvenanceSignature,
  verifyRfc6962InclusionProof,
} from '../src/index.js';

function ed25519() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey,
  };
}

describe('sha256Hex', () => {
  it('matches known vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('verifyDetachedSignature', () => {
  it('verifies an ed25519 signature and rejects tampering', () => {
    const { publicKeyPem, privateKey } = ed25519();
    const message = '{"canonical":true}';
    const signature = `base64:${signBytes(null, Buffer.from(message, 'utf8'), privateKey).toString('base64')}`;

    expect(verifyDetachedSignature({ algorithm: 'ed25519', publicKeyPem, message, signature })).toBe(true);
    expect(
      verifyDetachedSignature({ algorithm: 'ed25519', publicKeyPem, message: '{"canonical":false}', signature }),
    ).toBe(false);
    expect(verifyDetachedSignature({ algorithm: 'unknown', publicKeyPem, message, signature })).toBe(false);
    expect(
      verifyDetachedSignature({ algorithm: 'ed25519', publicKeyPem, message, signature: 'not-prefixed' }),
    ).toBe(false);
  });
});

describe('verifyProvenanceSignature', () => {
  it('classifies valid, stale, and invalid provenance signatures', () => {
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

    // Signed digest equals the current export -> valid.
    expect(
      verifyProvenanceSignature({ canonicalRdfBytes: canonicalBytes, currentProvenanceSha256: signedDigest, signature, resolvePublicKey }),
    ).toMatchObject({ digest_matches: true, signature_valid: true, verdict: 'valid' });

    // Provenance grew since signing -> still cryptographically valid, stale.
    expect(
      verifyProvenanceSignature({
        canonicalRdfBytes: canonicalBytes,
        currentProvenanceSha256: sha256Hex(`${canonicalBytes}<urn:d> <urn:e> <urn:f> .\n`),
        signature,
        resolvePublicKey,
      }),
    ).toMatchObject({ digest_matches: true, signature_valid: true, verdict: 'stale' });

    // Bytes do not match the signed digest (wrong artifact / tampering) -> invalid.
    expect(
      verifyProvenanceSignature({ canonicalRdfBytes: `${canonicalBytes}#tampered`, signature, resolvePublicKey }),
    ).toMatchObject({ digest_matches: false, signature_valid: false, verdict: 'invalid' });

    // Unresolvable key -> invalid.
    expect(
      verifyProvenanceSignature({ canonicalRdfBytes: canonicalBytes, signature, resolvePublicKey: () => undefined }),
    ).toMatchObject({ signature_valid: false, verdict: 'invalid' });
  });
});

describe('verifyEnvelopeSignatures', () => {
  it('recomputes the canonical digest and verifies detached signatures locally', () => {
    const { publicKeyPem, privateKey } = ed25519();
    const canonicalJson = '{"a":1}';
    const digest = sha256Hex(canonicalJson);
    const signature = `base64:${signBytes(null, Buffer.from(canonicalJson, 'utf8'), privateKey).toString('base64')}`;
    const envelope = {
      canonical_json: canonicalJson,
      canonical_json_sha256: digest,
      detached_signatures: [
        {
          key_ref: 'kms://demo/key',
          algorithm: 'ed25519',
          envelope_sha256: digest,
          signature,
        },
      ],
    };

    const verified = verifyEnvelopeSignatures({
      envelope,
      resolvePublicKey: (keyRef) => (keyRef === 'kms://demo/key' ? publicKeyPem : undefined),
    });
    expect(verified.canonical_json_sha256_matches).toBe(true);
    expect(verified.all_signatures_valid).toBe(true);
    expect(verified.signatures[0]).toMatchObject({ digest_matches: true, signature_valid: true });

    const tampered = verifyEnvelopeSignatures({
      envelope: { ...envelope, canonical_json: '{"a":2}' },
      resolvePublicKey: () => publicKeyPem,
    });
    // The recorded digests still agree with each other; the recompute
    // mismatch is surfaced on the envelope digest, and the signature no
    // longer verifies against the modified bytes.
    expect(tampered.canonical_json_sha256_matches).toBe(false);
    expect(tampered.all_signatures_valid).toBe(false);
    expect(tampered.signatures[0]).toMatchObject({ digest_matches: true, signature_valid: false });

    const missingKey = verifyEnvelopeSignatures({
      envelope,
      resolvePublicKey: () => undefined,
    });
    expect(missingKey.all_signatures_valid).toBe(false);
    expect(missingKey.signatures[0]).toMatchObject({ digest_matches: true, signature_valid: false });
  });
});

describe('RegistryClient.fetchArtifact', () => {
  it('verifies fetched bytes locally against the requested digest', async () => {
    const content = '# artifact\n';
    const digest = sha256Hex(content);
    let seenAuth: string | null = null;
    const fetchFn = async (input: Request | string) => {
      const request = input as Request;
      seenAuth = request.headers.get('authorization');
      return new Response(content, {
        status: 200,
        headers: { 'content-digest': `sha-256=:${Buffer.from(digest, 'hex').toString('base64')}:` },
      });
    };
    const client = new RegistryClient({ baseUrl: 'http://registry.test', apiToken: 'tok', fetch: fetchFn });

    const artifact = await client.fetchArtifact({ sha256: digest });
    expect(seenAuth).toBe('Bearer tok');
    expect(artifact.digest_verified).toBe(true);
    expect(Buffer.from(artifact.bytes).toString('utf8')).toBe(content);
  });

  it('reports tampered bytes and surfaces API errors', async () => {
    const requestedDigest = sha256Hex('original');
    const tamperedClient = new RegistryClient({
      baseUrl: 'http://registry.test',
      fetch: async () => new Response('tampered', { status: 200 }),
    });
    const tampered = await tamperedClient.fetchArtifact({ sha256: requestedDigest });
    expect(tampered.digest_verified).toBe(false);

    const missingClient = new RegistryClient({
      baseUrl: 'http://registry.test',
      fetch: async () =>
        new Response(JSON.stringify({ error: { code: 'ARTIFACT_NOT_FOUND', message: 'Artifact not found.' } }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
    });
    await expect(missingClient.fetchArtifact({ sha256: requestedDigest })).rejects.toBeInstanceOf(
      RegistryClientError,
    );

    const badInput = new RegistryClient({ baseUrl: 'http://registry.test' });
    await expect(badInput.fetchArtifact({ artifact_urn: 'urn:sg:artifact:sha256:zzz' })).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe('verifyRfc6962InclusionProof', () => {
  function nodeHash(left: Uint8Array, right: Uint8Array) {
    return createHash('sha256')
      .update(Buffer.concat([Buffer.from([0x01]), left, right]))
      .digest();
  }

  it('verifies proofs for a three-leaf tree and rejects tampering', () => {
    const leaves = [
      rfc6962LeafHash(Buffer.from('leaf-0')),
      rfc6962LeafHash(Buffer.from('leaf-1')),
      rfc6962LeafHash(Buffer.from('leaf-2')),
    ];
    const root = nodeHash(nodeHash(leaves[0]!, leaves[1]!), leaves[2]!);

    // Leaf 1 sits under the left subtree: proof is [leaf-0, leaf-2].
    expect(
      verifyRfc6962InclusionProof({
        leafHash: leaves[1]!,
        leafIndex: 1,
        treeSize: 3,
        proofHashes: [leaves[0]!, leaves[2]!],
        rootHash: root,
      }),
    ).toBe(true);

    // Leaf 2 is the odd right leaf: proof is [left-subtree-root].
    expect(
      verifyRfc6962InclusionProof({
        leafHash: leaves[2]!,
        leafIndex: 2,
        treeSize: 3,
        proofHashes: [nodeHash(leaves[0]!, leaves[1]!)],
        rootHash: root,
      }),
    ).toBe(true);

    expect(
      verifyRfc6962InclusionProof({
        leafHash: leaves[1]!,
        leafIndex: 1,
        treeSize: 3,
        proofHashes: [leaves[2]!, leaves[0]!],
        rootHash: root,
      }),
    ).toBe(false);

    expect(
      verifyRfc6962InclusionProof({
        leafHash: leaves[0]!,
        leafIndex: 3,
        treeSize: 3,
        proofHashes: [],
        rootHash: root,
      }),
    ).toBe(false);
  });
});
