import { readFileSync } from 'node:fs';
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { canonicalJsonString } from '../../../registry/application/services/canonical-json.js';
import { verifyKeylessBundle } from '../../../registry/application/services/keyless-verification.js';

const FIXTURES = path.resolve('tests/fixtures/keyless');

function fixturePem(name: string): string {
  return readFileSync(path.join(FIXTURES, `${name}.pem`), 'utf8');
}

function certDerBase64(name: string): string {
  return Buffer.from(fixturePem(name).replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, ''), 'base64').toString('base64');
}

function signWith(leafName: string, bytes: Buffer): string {
  return sign('sha256', bytes, createPrivateKey(fixturePem(`${leafName}-key`))).toString('base64');
}

function bundleFor(input: {
  leafName: string;
  signedBytes: Buffer;
  mode?: 'v03' | 'v02';
}): Record<string, unknown> {
  const digest = createHash('sha256').update(input.signedBytes).digest('base64');
  const signature = signWith(input.leafName, input.signedBytes);
  if (input.mode === 'v02') {
    return {
      mediaType: 'application/vnd.dev.sigstore.bundle+json;version=0.2',
      verificationMaterial: {
        x509CertificateChain: {
          certificates: [
            { rawBytes: certDerBase64(input.leafName) },
            { rawBytes: certDerBase64('intermediate') },
          ],
        },
        tlogEntries: [],
      },
      messageSignature: { messageDigest: { algorithm: 'SHA2_256', digest }, signature },
    };
  }
  return {
    mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
    verificationMaterial: {
      certificate: { rawBytes: certDerBase64(input.leafName) },
      tlogEntries: [],
    },
    messageSignature: { messageDigest: { algorithm: 'SHA2_256', digest }, signature },
  };
}

const policy = {
  trusted_root_pems: [fixturePem('intermediate'), fixturePem('root')],
  allowed_issuers: ['https://token.actions.githubusercontent.com'],
  allowed_subject_patterns: ['^https://github\\.com/togethercomputer/signet/'],
};

function rekorFixtures() {
  const privateKey = createPrivateKey(fixturePem('rekor-key'));
  const spkiDer = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }) as Buffer;
  return {
    privateKey,
    publicKeyPem: fixturePem('rekor'),
    logIdHex: createHash('sha256').update(spkiDer).digest('hex'),
  };
}

// Builds a serialized hashedrekord transparency entry whose SET is valid for
// the given log id; the canonical payload is signed with the fixture Rekor
// key. This also proves our JCS bytes match what the verifier recomputes.
function tlogEntryFixture(input: {
  signedBytes: Buffer;
  signatureBase64: string;
  integratedTime: number;
  logIndex: number;
  logIdHex: string;
  rekorPrivateKey: ReturnType<typeof createPrivateKey>;
  hashOverride?: string;
  signatureOverride?: string;
  setOverridePayload?: string;
}) {
  const body = {
    kind: 'hashedrekord',
    apiVersion: '0.0.1',
    spec: {
      data: {
        hash: {
          algorithm: 'sha256',
          value: input.hashOverride ?? createHash('sha256').update(input.signedBytes).digest('hex'),
        },
      },
      signature: {
        content: input.signatureOverride ?? input.signatureBase64,
        publicKey: { content: 'test' },
      },
    },
  };
  const canonicalizedBody = Buffer.from(JSON.stringify(body), 'utf8');
  const setPayload =
    input.setOverridePayload ??
    canonicalJsonString({
      body: canonicalizedBody.toString('base64'),
      integratedTime: input.integratedTime,
      logIndex: input.logIndex,
      logID: input.logIdHex,
    });
  const signedEntryTimestamp = sign(
    'sha256',
    Buffer.from(setPayload, 'utf8'),
    input.rekorPrivateKey,
  ).toString('base64');
  return {
    logIndex: String(input.logIndex),
    logId: { keyId: Buffer.from(input.logIdHex, 'hex').toString('base64') },
    kindVersion: { kind: 'hashedrekord', version: '0.0.1' },
    integratedTime: String(input.integratedTime),
    inclusionPromise: { signedEntryTimestamp },
    canonicalizedBody: canonicalizedBody.toString('base64'),
  };
}

function bundleWithTlog(input: {
  leafName: string;
  signedBytes: Buffer;
  signatureBase64: string;
  tlogEntry: Record<string, unknown>;
  mediaType?: 'v01' | 'v03';
}): Record<string, unknown> {
  const digest = createHash('sha256').update(input.signedBytes).digest('base64');
  const mediaType =
    input.mediaType === 'v03'
      ? 'application/vnd.dev.sigstore.bundle.v0.3+json'
      : 'application/vnd.dev.sigstore.bundle+json;version=0.1';
  return {
    mediaType,
    verificationMaterial: {
      ...(input.mediaType === 'v03'
        ? { certificate: { rawBytes: certDerBase64(input.leafName) } }
        : {
            x509CertificateChain: {
              certificates: [
                { rawBytes: certDerBase64(input.leafName) },
                { rawBytes: certDerBase64('intermediate') },
              ],
            },
          }),
      tlogEntries: [input.tlogEntry],
    },
    messageSignature: { messageDigest: { algorithm: 'SHA2_256', digest }, signature: input.signatureBase64 },
  };
}

// Builds a v0.3 inclusion-proof entry for a single-leaf tree (treeSize = 1):
// the proof is empty and the checkpoint's root hash is the RFC 6962 leaf hash
// of the canonicalized body, signed as a transparency-dev note.
function inclusionProofEntryFixture(input: {
  signedBytes: Buffer;
  signatureBase64: string;
  integratedTime: number;
  logIdHex: string;
  rekorPrivateKey: ReturnType<typeof createPrivateKey>;
  logHashOverride?: Buffer;
  checkpointKeyOverride?: ReturnType<typeof createPrivateKey>;
  checkpointSignatureTag?: boolean;
}) {
  const body = {
    kind: 'hashedrekord',
    apiVersion: '0.0.1',
    spec: {
      data: {
        hash: {
          algorithm: 'sha256',
          value: createHash('sha256').update(input.signedBytes).digest('hex'),
        },
      },
      signature: { content: input.signatureBase64, publicKey: { content: 'test' } },
    },
  };
  const canonicalizedBody = Buffer.from(JSON.stringify(body), 'utf8');
  const leafHash = createHash('sha256')
    .update(Buffer.from([0x00]))
    .update(canonicalizedBody)
    .digest();
  const logHash = input.logHashOverride ?? leafHash;
  const checkpointBody = `rekor.test.local - 0000
1
${logHash.toString('base64')}
`;
  const checkpointKey = input.checkpointKeyOverride ?? input.rekorPrivateKey;
  const checkpointSignature = sign('sha256', Buffer.from(checkpointBody, 'utf8'), checkpointKey);
  const keyHint = Buffer.from(input.logIdHex, 'hex').subarray(0, 4);
  const envelope = `${checkpointBody}
— rekor.test.local ${Buffer.concat([keyHint, checkpointSignature]).toString('base64')}
`;
  return {
    logIndex: '0',
    logId: { keyId: Buffer.from(input.logIdHex, 'hex').toString('base64') },
    kindVersion: { kind: 'hashedrekord', version: '0.0.1' },
    integratedTime: String(input.integratedTime),
    inclusionProof: {
      logIndex: '0',
      rootHash: logHash.toString('base64'),
      hashes: [],
      checkpoint: { envelope },
    },
    canonicalizedBody: canonicalizedBody.toString('base64'),
  };
}

function hashedRekordBody(input: {
  signedBytes: Buffer;
  signatureBase64: string;
  hashOverride?: string;
}): Buffer {
  const body = {
    kind: 'hashedrekord',
    apiVersion: '0.0.1',
    spec: {
      data: {
        hash: {
          algorithm: 'sha256',
          value: input.hashOverride ?? createHash('sha256').update(input.signedBytes).digest('hex'),
        },
      },
      signature: { content: input.signatureBase64, publicKey: { content: 'test' } },
    },
  };
  return Buffer.from(JSON.stringify(body), 'utf8');
}

function testLeafHash(leaf: Buffer): Buffer {
  return createHash('sha256').update(Buffer.concat([Buffer.from([0x00]), leaf])).digest();
}

function testNodeHash(left: Buffer, right: Buffer): Buffer {
  return createHash('sha256').update(Buffer.concat([Buffer.from([0x01]), left, right])).digest();
}

function testLargestPowerOfTwoLessThan(n: number): number {
  let k = 1;
  while (k < n) k <<= 1;
  return k >> 1;
}

function testSubtreeRoot(leaves: Buffer[], start: number, end: number): Buffer {
  const n = end - start;
  if (n === 1) return leaves[start] as Buffer;
  const k = testLargestPowerOfTwoLessThan(n);
  return testNodeHash(testSubtreeRoot(leaves, start, start + k), testSubtreeRoot(leaves, start + k, end));
}

function testAuditPath(leaves: Buffer[], start: number, end: number, index: number, path: Buffer[]): void {
  const n = end - start;
  if (n === 1) return;
  const k = testLargestPowerOfTwoLessThan(n);
  if (index < start + k) {
    testAuditPath(leaves, start, start + k, index, path);
    path.push(testSubtreeRoot(leaves, start + k, end));
  } else {
    testAuditPath(leaves, start + k, end, index, path);
    path.push(testSubtreeRoot(leaves, start, start + k));
  }
}

// Builds a hashedrekord entry that is a real leaf in an N-leaf RFC 6962 tree,
// with an audit path (hashes.length > 0) so inclusion-proof chaining is
// exercised end to end, and an optional signed entry timestamp (real Rekor
// v1 bundles carry both a promise and a proof).
function multiLeafInclusionProofFixture(input: {
  leaves: Buffer[];
  leafIndex: number;
  integratedTime: number;
  logIdHex: string;
  rekorPrivateKey: ReturnType<typeof createPrivateKey>;
  withPromise?: boolean;
  proofHashOverride?: (hashes: Buffer[]) => Buffer[];
}): Record<string, unknown> {
  const leafHashes = input.leaves.map((leaf) => testLeafHash(leaf));
  const rootHash = testSubtreeRoot(leafHashes, 0, leafHashes.length);
  const path: Buffer[] = [];
  testAuditPath(leafHashes, 0, leafHashes.length, input.leafIndex, path);
  const proofHashes = input.proofHashOverride ? input.proofHashOverride(path) : path;
  const checkpointBody = `rekor.test.local - 0000
${leafHashes.length}
${rootHash.toString('base64')}
`;
  const checkpointSignature = sign('sha256', Buffer.from(checkpointBody, 'utf8'), input.rekorPrivateKey);
  const keyHint = Buffer.from(input.logIdHex, 'hex').subarray(0, 4);
  const envelope = `${checkpointBody}
— rekor.test.local ${Buffer.concat([keyHint, checkpointSignature]).toString('base64')}
`;
  const canonicalizedBody = input.leaves[input.leafIndex] as Buffer;
  const entry: Record<string, unknown> = {
    logIndex: String(input.leafIndex),
    logId: { keyId: Buffer.from(input.logIdHex, 'hex').toString('base64') },
    kindVersion: { kind: 'hashedrekord', version: '0.0.1' },
    integratedTime: String(input.integratedTime),
    inclusionProof: {
      logIndex: String(input.leafIndex),
      rootHash: rootHash.toString('base64'),
      hashes: proofHashes.map((hash) => hash.toString('base64')),
      checkpoint: { envelope },
    },
    canonicalizedBody: canonicalizedBody.toString('base64'),
  };
  if (input.withPromise) {
    const setPayload = canonicalJsonString({
      body: canonicalizedBody.toString('base64'),
      integratedTime: input.integratedTime,
      logIndex: input.leafIndex,
      logID: input.logIdHex,
    });
    entry['inclusionPromise'] = {
      signedEntryTimestamp: sign('sha256', Buffer.from(setPayload, 'utf8'), input.rekorPrivateKey).toString('base64'),
    };
  }
  return entry;
}

describe('verifyKeylessBundle', () => {
  const signedBytes = Buffer.from('keyless payload', 'utf8');

  it('verifies v0.3 (leaf-only) and v0.2 (bundled chain) bundles', () => {
    const v03 = verifyKeylessBundle({ bundle: bundleFor({ leafName: 'leaf', signedBytes }), signed_bytes: signedBytes, policy });
    expect(v03).toMatchObject({
      verified: true,
      identity: 'https://github.com/togethercomputer/signet/.github/workflows/release.yaml@refs/tags/v0.1.28',
      issuer: 'https://token.actions.githubusercontent.com',
      algorithm: 'ecdsa-p256-sha256',
    });
    expect(v03.certificate_chain_pem).toContain('BEGIN CERTIFICATE');

    const v02 = verifyKeylessBundle({
      bundle: bundleFor({ leafName: 'leaf', signedBytes, mode: 'v02' }),
      signed_bytes: signedBytes,
      policy,
    });
    expect(v02.verified).toBe(true);
  });

  it('reads the OIDC issuer from both extension profiles', () => {
    const v2 = verifyKeylessBundle({ bundle: bundleFor({ leafName: 'leaf-v2', signedBytes }), signed_bytes: signedBytes, policy });
    expect(v2).toMatchObject({ verified: true, issuer: 'https://token.actions.githubusercontent.com' });
  });

  it('accepts email identities when the policy allows them', () => {
    const outcome = verifyKeylessBundle({
      bundle: bundleFor({ leafName: 'leaf-email', signedBytes }),
      signed_bytes: signedBytes,
      policy: { ...policy, allowed_subject_patterns: ['^release-bot@together\\.ai$'] },
    });
    expect(outcome).toMatchObject({ verified: true, identity: 'release-bot@together.ai' });
  });

  it('rejects chains that do not resolve to a trusted root', () => {
    const outcome = verifyKeylessBundle({ bundle: bundleFor({ leafName: 'leaf-other-root', signedBytes }), signed_bytes: signedBytes, policy });
    expect(outcome).toMatchObject({ verified: false, failure_kind: 'untrusted_certificate' });
  });

  it('enforces the issuer and subject policies', () => {
    const wrongIssuer = verifyKeylessBundle({ bundle: bundleFor({ leafName: 'leaf-other-issuer', signedBytes }), signed_bytes: signedBytes, policy });
    expect(wrongIssuer).toMatchObject({ verified: false, failure_kind: 'identity_policy_failed' });
    expect(wrongIssuer.error).toContain('issuer');

    const wrongSubject = verifyKeylessBundle({ bundle: bundleFor({ leafName: 'leaf-other-subject', signedBytes }), signed_bytes: signedBytes, policy });
    expect(wrongSubject).toMatchObject({ verified: false, failure_kind: 'identity_policy_failed' });
    expect(wrongSubject.error).toContain('identity');
  });

  it('detects tampered payloads and signatures', () => {
    const digestMismatch = verifyKeylessBundle({ bundle: bundleFor({ leafName: 'leaf', signedBytes }), signed_bytes: Buffer.from('other'), policy });
    expect(digestMismatch).toMatchObject({ verified: false, failure_kind: 'digest_mismatch' });

    const bundle = bundleFor({ leafName: 'leaf', signedBytes });
    (bundle['messageSignature'] as Record<string, unknown>)['signature'] = signWith('leaf-v2', signedBytes);
    const wrongSignature = verifyKeylessBundle({ bundle, signed_bytes: signedBytes, policy });
    expect(wrongSignature).toMatchObject({ verified: false, failure_kind: 'cryptographic_failure' });
  });

  it('rejects expired certificates and unconfigured policies', () => {
    const expired = verifyKeylessBundle({
      bundle: bundleFor({ leafName: 'leaf', signedBytes }),
      signed_bytes: signedBytes,
      policy,
      at: new Date('2030-01-01'),
    });
    expect(expired).toMatchObject({ verified: false, failure_kind: 'expired_certificate' });

    const unconfigured = verifyKeylessBundle({ bundle: bundleFor({ leafName: 'leaf', signedBytes }), signed_bytes: signedBytes, policy: null });
    expect(unconfigured).toMatchObject({ verified: false, failure_kind: 'not_configured' });
  });

  it('anchors validity at a verified, bound Rekor entry', () => {
    const signedBytes = Buffer.from('keyless payload with transparency entry', 'utf8');
    const rekor = rekorFixtures();
    const signatureBase64 = signWith('leaf', signedBytes);
    const integratedTime = Math.floor(Date.now() / 1000) + 1;
    const tlogEntry = tlogEntryFixture({
      signedBytes,
      signatureBase64,
      integratedTime,
      logIndex: 7,
      logIdHex: rekor.logIdHex,
      rekorPrivateKey: rekor.privateKey,
    });
    const bundle = bundleWithTlog({ leafName: 'leaf', signedBytes, signatureBase64, tlogEntry });
    const withRekor = { ...policy, rekor_public_key_pem: rekor.publicKeyPem, rekor_log_id: rekor.logIdHex };

    // The fallback time is long past the certificate's validity window; the
    // bound transparency entry must anchor validity at its integratedTime.
    const outcome = verifyKeylessBundle({ bundle, signed_bytes: signedBytes, policy: withRekor, at: new Date('2030-01-01') });
    expect(outcome).toMatchObject({
      verified: true,
      tlog: {
        present: true,
        verified: true,
        body_bound: true,
        log_index: 7,
        integrated_time: new Date(integratedTime * 1000).toISOString(),
      },
      validity_evaluated_at: new Date(integratedTime * 1000).toISOString(),
    });

    // Without Rekor trust configured, tlog-carrying bundles fail closed.
    const unconfigured = verifyKeylessBundle({ bundle, signed_bytes: signedBytes, policy, at: new Date('2030-01-01') });
    expect(unconfigured).toMatchObject({ verified: false, failure_kind: 'tlog_not_configured' });
  });

  it('rejects invalid and mismatched transparency entries', () => {
    const signedBytes = Buffer.from('keyless payload negative transparency', 'utf8');
    const rekor = rekorFixtures();
    const signatureBase64 = signWith('leaf', signedBytes);
    const baseEntry = {
      signedBytes,
      signatureBase64,
      integratedTime: Math.floor(Date.now() / 1000) + 1,
      logIndex: 3,
      logIdHex: rekor.logIdHex,
      rekorPrivateKey: rekor.privateKey,
    };
    const withRekor = { ...policy, rekor_public_key_pem: rekor.publicKeyPem, rekor_log_id: rekor.logIdHex };

    const tamperedEntry = tlogEntryFixture({ ...baseEntry, setOverridePayload: 'not the entry payload' });
    const tampered = verifyKeylessBundle({
      bundle: bundleWithTlog({ leafName: 'leaf', signedBytes, signatureBase64, tlogEntry: tamperedEntry }),
      signed_bytes: signedBytes,
      policy: withRekor,
    });
    expect(tampered).toMatchObject({ verified: false, failure_kind: 'tlog_inclusion_promise_failed' });

    const mismatchedLog = verifyKeylessBundle({
      bundle: bundleWithTlog({
        leafName: 'leaf',
        signedBytes,
        signatureBase64,
        tlogEntry: tlogEntryFixture(baseEntry),
      }),
      signed_bytes: signedBytes,
      policy: { ...withRekor, rekor_log_id: 'ab'.repeat(32) },
    });
    expect(mismatchedLog).toMatchObject({ verified: false, failure_kind: 'tlog_inclusion_promise_failed' });
  });

  it('does not anchor on entries that are not bound to the payload', () => {
    const signedBytes = Buffer.from('keyless payload unbound entry', 'utf8');
    const rekor = rekorFixtures();
    const signatureBase64 = signWith('leaf', signedBytes);
    const entry = tlogEntryFixture({
      signedBytes,
      signatureBase64,
      integratedTime: Math.floor(Date.now() / 1000) + 1,
      logIndex: 9,
      logIdHex: rekor.logIdHex,
      rekorPrivateKey: rekor.privateKey,
      hashOverride: createHash('sha256').update('a different payload').digest('hex'),
    });
    const outcome = verifyKeylessBundle({
      bundle: bundleWithTlog({ leafName: 'leaf', signedBytes, signatureBase64, tlogEntry: entry }),
      signed_bytes: signedBytes,
      policy: { ...policy, rekor_public_key_pem: rekor.publicKeyPem, rekor_log_id: rekor.logIdHex },
      at: new Date('2030-01-01'),
    });
    // SET verifies, but the entry is not ours: validity must NOT switch to
    // the entry's time, so the (expired) fallback time still fails closed.
    expect(outcome).toMatchObject({
      verified: false,
      failure_kind: 'expired_certificate',
      tlog: { present: true, verified: true, body_bound: false },
    });
  });

  it('uses the witnessed time for proof-only entries: inclusion proofs do not verify integratedTime', () => {
    const signedBytes = Buffer.from('keyless payload with inclusion proof', 'utf8');
    const rekor = rekorFixtures();
    const signatureBase64 = signWith('leaf', signedBytes);
    const integratedTime = Math.floor(Date.now() / 1000) + 1;
    const tlogEntry = inclusionProofEntryFixture({
      signedBytes,
      signatureBase64,
      integratedTime,
      logIdHex: rekor.logIdHex,
      rekorPrivateKey: rekor.privateKey,
    });
    const bundle = bundleWithTlog({ leafName: 'leaf', signedBytes, signatureBase64, tlogEntry, mediaType: 'v03' });
    const withRekor = { ...policy, rekor_public_key_pem: rekor.publicKeyPem, rekor_log_id: rekor.logIdHex };
    const at = new Date();
    const outcome = verifyKeylessBundle({ bundle, signed_bytes: signedBytes, policy: withRekor, at });
    expect(outcome).toMatchObject({
      verified: true,
      tlog: {
        present: true,
        verified: true,
        body_bound: true,
        integrated_time_verified: false,
        integrated_time: new Date(integratedTime * 1000).toISOString(),
      },
      validity_evaluated_at: at.toISOString(),
    });
  });

  it('verifies multi-leaf inclusion proofs (inner and border chaining)', () => {
    const signedBytes = Buffer.from('keyless payload multi-leaf proof', 'utf8');
    const rekor = rekorFixtures();
    const signatureBase64 = signWith('leaf', signedBytes);
    const integratedTime = Math.floor(Date.now() / 1000) + 2;
    const leaves = [0, 1, 2, 3].map((index) =>
      hashedRekordBody({
        signedBytes: index === 2 ? signedBytes : Buffer.from(`other tree leaf ${index}`, 'utf8'),
        signatureBase64: index === 2 ? signatureBase64 : 'unrelated signature',
      }),
    );
    const withRekor = { ...policy, rekor_public_key_pem: rekor.publicKeyPem, rekor_log_id: rekor.logIdHex };
    const at = new Date();

    // Leaf 2 of a 4-leaf tree needs one inner and one border sibling, so both
    // inclusion-proof chaining paths execute.
    const tlogEntry = multiLeafInclusionProofFixture({
      leaves,
      leafIndex: 2,
      integratedTime,
      logIdHex: rekor.logIdHex,
      rekorPrivateKey: rekor.privateKey,
    });
    const outcome = verifyKeylessBundle({
      bundle: bundleWithTlog({ leafName: 'leaf', signedBytes, signatureBase64, tlogEntry, mediaType: 'v03' }),
      signed_bytes: signedBytes,
      policy: withRekor,
      at,
    });
    expect(outcome).toMatchObject({
      verified: true,
      tlog: {
        present: true,
        verified: true,
        body_bound: true,
        integrated_time_verified: false,
        log_index: 2,
        integrated_time: new Date(integratedTime * 1000).toISOString(),
      },
      validity_evaluated_at: at.toISOString(),
    });

    const tamperedPath = multiLeafInclusionProofFixture({
      leaves,
      leafIndex: 2,
      integratedTime,
      logIdHex: rekor.logIdHex,
      rekorPrivateKey: rekor.privateKey,
      proofHashOverride: (hashes) => {
        const flipped = [...hashes];
        flipped[0] = createHash('sha256').update('not a tree node').digest();
        return flipped;
      },
    });
    const rejected = verifyKeylessBundle({
      bundle: bundleWithTlog({ leafName: 'leaf', signedBytes, signatureBase64, tlogEntry: tamperedPath, mediaType: 'v03' }),
      signed_bytes: signedBytes,
      policy: withRekor,
      at,
    });
    expect(rejected).toMatchObject({ verified: false, failure_kind: 'tlog_inclusion_promise_failed' });
  });

  it('verifies the SET alongside the proof and anchors at the attested time', () => {
    const signedBytes = Buffer.from('keyless payload promise and proof', 'utf8');
    const rekor = rekorFixtures();
    const signatureBase64 = signWith('leaf', signedBytes);
    const integratedTime = Math.floor(Date.now() / 1000) + 2;
    const leaves = [0, 1, 2, 3].map((index) =>
      hashedRekordBody({
        signedBytes: index === 2 ? signedBytes : Buffer.from(`other tree leaf ${index}`, 'utf8'),
        signatureBase64: index === 2 ? signatureBase64 : 'unrelated signature',
      }),
    );
    const withRekor = { ...policy, rekor_public_key_pem: rekor.publicKeyPem, rekor_log_id: rekor.logIdHex };
    const entryWithBoth = multiLeafInclusionProofFixture({
      leaves,
      leafIndex: 2,
      integratedTime,
      logIdHex: rekor.logIdHex,
      rekorPrivateKey: rekor.privateKey,
      withPromise: true,
    });

    // The fallback time is far past the certificate's validity window; the
    // authenticated integratedTime must anchor validity instead.
    const good = verifyKeylessBundle({
      bundle: bundleWithTlog({ leafName: 'leaf', signedBytes, signatureBase64, tlogEntry: entryWithBoth, mediaType: 'v03' }),
      signed_bytes: signedBytes,
      policy: withRekor,
      at: new Date('2030-01-01'),
    });
    expect(good).toMatchObject({
      verified: true,
      tlog: {
        present: true,
        verified: true,
        body_bound: true,
        integrated_time_verified: true,
        log_index: 2,
        integrated_time: new Date(integratedTime * 1000).toISOString(),
      },
      validity_evaluated_at: new Date(integratedTime * 1000).toISOString(),
    });

    // A tampered SET must fail even though the inclusion proof verifies:
    // real Rekor v1 bundles carry both, and the SET is what authenticates
    // integratedTime.
    const tamperedSet = {
      ...entryWithBoth,
      inclusionPromise: {
        signedEntryTimestamp: sign('sha256', Buffer.from('not the set payload', 'utf8'), rekor.privateKey).toString(
          'base64',
        ),
      },
    };
    const rejected = verifyKeylessBundle({
      bundle: bundleWithTlog({ leafName: 'leaf', signedBytes, signatureBase64, tlogEntry: tamperedSet, mediaType: 'v03' }),
      signed_bytes: signedBytes,
      policy: withRekor,
      at: new Date('2030-01-01'),
    });
    expect(rejected).toMatchObject({ verified: false, failure_kind: 'tlog_inclusion_promise_failed' });
  });

  it('requires live certificate validity at attach even when a SET anchors the entry', () => {
    const signedBytes = Buffer.from('keyless payload attach clock', 'utf8');
    const rekor = rekorFixtures();
    const signatureBase64 = signWith('leaf', signedBytes);
    const integratedTime = Math.floor(Date.now() / 1000) + 2;
    const tlogEntry = tlogEntryFixture({
      signedBytes,
      signatureBase64,
      integratedTime,
      logIndex: 4,
      logIdHex: rekor.logIdHex,
      rekorPrivateKey: rekor.privateKey,
    });
    const bundle = bundleWithTlog({ leafName: 'leaf', signedBytes, signatureBase64, tlogEntry });
    const withRekor = { ...policy, rekor_public_key_pem: rekor.publicKeyPem, rekor_log_id: rekor.logIdHex };
    const attachNow = new Date();

    const ok = verifyKeylessBundle({
      bundle,
      signed_bytes: signedBytes,
      policy: withRekor,
      at: attachNow,
      require_valid_at: attachNow,
    });
    expect(ok).toMatchObject({ verified: true });

    const stale = verifyKeylessBundle({
      bundle,
      signed_bytes: signedBytes,
      policy: withRekor,
      at: attachNow,
      require_valid_at: new Date('2030-01-01'),
    });
    expect(stale).toMatchObject({
      verified: false,
      failure_kind: 'expired_certificate',
      tlog: { present: true, verified: true, integrated_time_verified: true },
    });
  });

  it('rejects inclusion proofs with invalid checkpoints', () => {
    const signedBytes = Buffer.from('keyless payload bad checkpoint', 'utf8');
    const rekor = rekorFixtures();
    const signatureBase64 = signWith('leaf', signedBytes);
    const withRekor = { ...policy, rekor_public_key_pem: rekor.publicKeyPem, rekor_log_id: rekor.logIdHex };

    const forgedCheckpoint = inclusionProofEntryFixture({
      signedBytes,
      signatureBase64,
      integratedTime: Math.floor(Date.now() / 1000) + 1,
      logIdHex: rekor.logIdHex,
      rekorPrivateKey: rekor.privateKey,
      checkpointKeyOverride: createPrivateKey(fixturePem('leaf-key')),
    });
    const forged = verifyKeylessBundle({
      bundle: bundleWithTlog({ leafName: 'leaf', signedBytes, signatureBase64, tlogEntry: forgedCheckpoint, mediaType: 'v03' }),
      signed_bytes: signedBytes,
      policy: withRekor,
    });
    expect(forged).toMatchObject({ verified: false, failure_kind: 'tlog_inclusion_promise_failed' });

    const wrongRoot = inclusionProofEntryFixture({
      signedBytes,
      signatureBase64,
      integratedTime: Math.floor(Date.now() / 1000) + 1,
      logIdHex: rekor.logIdHex,
      rekorPrivateKey: rekor.privateKey,
      logHashOverride: createHash('sha256').update('some other tree').digest(),
    });
    const mismatched = verifyKeylessBundle({
      bundle: bundleWithTlog({ leafName: 'leaf', signedBytes, signatureBase64, tlogEntry: wrongRoot, mediaType: 'v03' }),
      signed_bytes: signedBytes,
      policy: withRekor,
    });
    expect(mismatched).toMatchObject({ verified: false, failure_kind: 'tlog_inclusion_promise_failed' });
  });

  it('fails closed when the signed payload bytes are unavailable', () => {
    // Chain and policy may check out, but without the signed bytes the
    // signature itself cannot be verified, so the result must not claim
    // verification (the bundle signature could be for any payload).
    const outcome = verifyKeylessBundle({ bundle: bundleFor({ leafName: 'leaf', signedBytes }), policy });
    expect(outcome).toMatchObject({
      verified: false,
      failure_kind: 'signature_not_checked',
      identity: expect.stringContaining('github.com'),
    });
  });
});
