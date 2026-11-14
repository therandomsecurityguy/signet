import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

import { bundleFromJSON, type Bundle } from '@sigstore/bundle';
import { HashAlgorithm } from '@sigstore/protobuf-specs';
import { X509Certificate, crypto as sigstoreCrypto, json as sigstoreJson } from '@sigstore/core';

// Keyless (sigstore) publication signatures: the signer presents an X.509
// certificate issued by a configured Fulcio-compatible CA, bound to an OIDC
// identity. Trust comes from a policy (trusted roots + allowed OIDC issuers +
// allowed subject patterns) instead of a pre-registered public key.
export type KeylessTrustPolicy = {
  trusted_root_pems: string[];
  allowed_issuers: string[];
  allowed_subject_patterns: string[];
  // Transparency-log anchoring (Rekor): when a bundle carries a signed entry
  // timestamp (inclusion promise), the registry verifies it against this log
  // and anchors certificate validity at the attested integratedTime.
  rekor_public_key_pem?: string;
  rekor_log_id?: string;
};

export type KeylessTLogVerification = {
  present: boolean;
  verified: boolean;
  body_bound: boolean;
  // True only when a signed entry timestamp authenticated the entry's
  // integratedTime (inclusion proofs do not cover it).
  integrated_time_verified: boolean;
  log_index?: number;
  integrated_time?: string;
  failure_kind?: string;
  error?: string;
};

export type KeylessVerificationFailureKind =
  | 'not_configured'
  | 'invalid_bundle'
  | 'untrusted_certificate'
  | 'expired_certificate'
  | 'identity_policy_failed'
  | 'digest_mismatch'
  | 'cryptographic_failure'
  | 'signature_not_checked'
  | 'tlog_inclusion_promise_failed'
  | 'tlog_not_configured'
  | 'unsupported_key';

export type KeylessVerificationResult = {
  verified: boolean;
  identity?: string;
  issuer?: string;
  algorithm?: string;
  certificate_chain_pem?: string;
  failure_kind?: KeylessVerificationFailureKind;
  error?: string;
  // Transparency-log verdict; integrated_time (ISO) is the validity anchor
  // when the entry is verified AND bound to the signed payload.
  tlog?: KeylessTLogVerification;
  // The moment certificate validity was evaluated against (the tlog's
  // integratedTime when bound, otherwise the caller's `at`).
  validity_evaluated_at?: string;
};

const OIDC_ISSUER_OID_V1 = '1.3.6.1.4.1.57264.1.1';
const OIDC_ISSUER_OID_V2 = '1.3.6.1.4.1.57264.1.8';

type ParsedCertificate = {
  cert: X509Certificate;
  der: Buffer;
  pem: string;
};

function toParsedCertificate(der: Buffer): ParsedCertificate {
  const base64 = der.toString('base64');
  const body = base64.match(/.{1,64}/g)?.join('\n') ?? base64;
  return {
    cert: X509Certificate.parse(Buffer.from(der)),
    der,
    pem: `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`,
  };
}

export function parsePemCertificates(pem: string): ParsedCertificate[] {
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
  return blocks.map((block) =>
    toParsedCertificate(
      Buffer.from(block.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, ''), 'base64'),
    ),
  );
}

function bundleCertificateChain(bundle: Bundle): ParsedCertificate[] {
  const content = bundle.verificationMaterial.content;
  if (content.$case === 'x509CertificateChain') {
    return content.x509CertificateChain.certificates.map((entry) => toParsedCertificate(Buffer.from(entry.rawBytes)));
  }
  if (content.$case === 'certificate') {
    const chainMaterial = bundle.verificationMaterial as unknown as {
      certificateChain?: { certificates: Array<{ rawBytes: string | Uint8Array }> };
    };
    const rest = chainMaterial.certificateChain?.certificates ?? [];
    return [content.certificate, ...rest].map((entry) => toParsedCertificate(Buffer.from(entry.rawBytes)));
  }
  return [];
}

function oidcIssuerFromCertificate(cert: X509Certificate): string | undefined {
  const v2 = cert.extension(OIDC_ISSUER_OID_V2);
  if (v2) {
    const value = v2.valueObj?.subs?.[0]?.value;
    if (value) return value.toString('ascii');
  }
  const v1 = cert.extension(OIDC_ISSUER_OID_V1);
  return v1 ? v1.value.toString('ascii') : undefined;
}

function keylessAlgorithmLabel(key: KeyObject): string {
  switch (key.asymmetricKeyType) {
    case 'ed25519':
      return 'ed25519';
    case 'rsa':
    case 'rsa-pss':
      return 'rsa-sha256';
    case 'ec':
      return key.asymmetricKeyDetails?.namedCurve === 'secp384r1' ? 'ecdsa-p384-sha384' : 'ecdsa-p256-sha256';
    default:
      return 'unknown';
  }
}

// Ported from sigstore-js (@sigstore/verify): the signed entry timestamp
// covers the JCS-canonicalized Rekor verification payload built from the
// parsed entry.
function verifySignedEntryTimestamp(input: {
  entry: {
    canonicalizedBody: Uint8Array;
    integratedTime: number | bigint | string;
    logIndex: number | bigint | string;
    logId: { keyId: Uint8Array };
    inclusionPromise: { signedEntryTimestamp: Uint8Array };
  };
  rekorPublicKeyPem: string;
}): { verified: boolean; error?: string } {
  let publicKey: KeyObject;
  try {
    publicKey = sigstoreCrypto.createPublicKey(input.rekorPublicKeyPem) as unknown as KeyObject;
  } catch {
    return { verified: false, error: 'configured Rekor public key could not be parsed' };
  }
  const payload = {
    body: Buffer.from(input.entry.canonicalizedBody).toString('base64'),
    integratedTime: Number(input.entry.integratedTime),
    logIndex: Number(input.entry.logIndex),
    logID: Buffer.from(input.entry.logId.keyId).toString('hex'),
  };
  const data = Buffer.from(sigstoreJson.canonicalize(payload), 'utf8');
  try {
    const verified = sigstoreCrypto.verify(
      data,
      publicKey as never,
      Buffer.from(input.entry.inclusionPromise.signedEntryTimestamp),
    );
    return verified ? { verified: true } : { verified: false, error: 'inclusion promise signature is invalid' };
  } catch (err) {
    return { verified: false, error: err instanceof Error ? err.message : 'inclusion promise verification failed' };
  }
}

// Binds a hashedrekord entry to the signed payload: the entry's data hash and
// embedded signature must match what the registry is verifying, otherwise a
// valid SET over an unrelated entry would prove nothing about this bundle.
function hashedRekordBindsPayload(input: {
  canonicalizedBody: Uint8Array;
  signedBytes: Buffer;
  signatureFromBundle: Buffer | undefined;
}): { kind: string; bound: boolean } {
  let parsed: {
    kind?: unknown;
    spec?: {
      data?: { hash?: { algorithm?: unknown; value?: unknown } };
      signature?: { content?: unknown };
    };
  };
  try {
    parsed = JSON.parse(Buffer.from(input.canonicalizedBody).toString('utf8')) as typeof parsed;
  } catch {
    return { kind: 'unparseable', bound: false };
  }
  const kind = typeof parsed.kind === 'string' ? parsed.kind : 'unknown';
  if (kind !== 'hashedrekord') return { kind, bound: false };
  const algorithm = parsed.spec?.data?.hash?.algorithm;
  const value = parsed.spec?.data?.hash?.value;
  if (algorithm !== 'sha256' || typeof value !== 'string') return { kind, bound: false };
  const expectedDigest = createHash('sha256').update(input.signedBytes).digest('hex');
  if (value.toLowerCase() !== expectedDigest) return { kind, bound: false };
  const entrySignature = parsed.spec?.signature?.content;
  if (typeof entrySignature === 'string' && input.signatureFromBundle) {
    if (Buffer.from(entrySignature, 'base64').toString('base64') !== input.signatureFromBundle.toString('base64')) {
      return { kind, bound: false };
    }
  }
  return { kind, bound: true };
}

// --- RFC 6962 inclusion proof + checkpoint verification (ported from
// sigstore-js @sigstore/verify for v0.2/v0.3 bundles, which carry an
// inclusionProof instead of an inclusion promise). ---

const RFC6962_LEAF_HASH_PREFIX = Buffer.from([0x00]);
const RFC6962_NODE_HASH_PREFIX = Buffer.from([0x01]);
const CHECKPOINT_SEPARATOR = '\n\n';
const CHECKPOINT_SIGNATURE_REGEX = /\u2014 (\S+) (\S+)\n/g;

function hashChildrenBytes(left: Uint8Array, right: Uint8Array): Buffer {
  return createHash('sha256').update(RFC6962_NODE_HASH_PREFIX).update(left).update(right).digest();
}

function bitLength(value: bigint): number {
  return value === 0n ? 0 : value.toString(2).length;
}

function onesCount(value: bigint): number {
  return value.toString(2).split('1').length - 1;
}

function chainInner(seed: Buffer, hashes: Uint8Array[], index: bigint): Buffer {
  return hashes.reduce<Buffer>((acc, hash, i) => {
    if ((index >> BigInt(i)) & 1n) {
      return hashChildrenBytes(hash, acc);
    }
    return hashChildrenBytes(acc, hash);
  }, seed);
}

function chainBorderRight(seed: Buffer, hashes: Uint8Array[]): Buffer {
  return hashes.reduce<Buffer>((acc, hash) => hashChildrenBytes(hash, acc), seed);
}

type ParsedTLogEntry = {
  canonicalizedBody: Uint8Array;
  integratedTime: number | bigint | string;
  logIndex: number | bigint | string;
  logId: { keyId: Uint8Array };
  inclusionPromise?: { signedEntryTimestamp: Uint8Array } | undefined;
  inclusionProof?: {
    logIndex: number | bigint | string;
    rootHash: Uint8Array;
    hashes?: Uint8Array[] | undefined;
    checkpoint?: { envelope: string } | undefined;
  } | undefined;
};

function parseCheckpointNote(envelope: string): {
  note: string;
  signatures: Array<{ keyHint: Buffer; signature: Buffer }>;
} | null {
  if (!envelope.includes(CHECKPOINT_SEPARATOR)) return null;
  const split = envelope.indexOf(CHECKPOINT_SEPARATOR);
  const note = envelope.slice(0, split + 1);
  const data = envelope.slice(split + CHECKPOINT_SEPARATOR.length);
  const signatures: Array<{ keyHint: Buffer; signature: Buffer }> = [];
  for (const match of data.matchAll(CHECKPOINT_SIGNATURE_REGEX)) {
    const bytes = Buffer.from(match[2] ?? '', 'base64');
    if (bytes.length < 5) return null;
    signatures.push({ keyHint: bytes.subarray(0, 4), signature: bytes.subarray(4) });
  }
  return signatures.length > 0 ? { note, signatures } : null;
}

function verifyCheckpointAndInclusion(input: {
  entry: ParsedTLogEntry;
  rekorPublicKeyPem: string;
  logIdHex: string;
}): { verified: boolean; logSize?: bigint; logHash?: Buffer; error?: string } {
  const inclusionProof = input.entry.inclusionProof;
  if (!inclusionProof) return { verified: false, error: 'entry carries no inclusion proof' };
  const envelope = inclusionProof.checkpoint?.envelope;
  if (typeof envelope !== 'string') return { verified: false, error: 'entry carries no checkpoint' };
  const parsedNote = parseCheckpointNote(envelope);
  if (!parsedNote) return { verified: false, error: 'malformed checkpoint note' };

  let publicKey: KeyObject;
  try {
    publicKey = sigstoreCrypto.createPublicKey(input.rekorPublicKeyPem) as unknown as KeyObject;
  } catch {
    return { verified: false, error: 'configured Rekor public key could not be parsed' };
  }
  const logIdBytes = Buffer.from(input.logIdHex, 'hex');
  const noteData = Buffer.from(parsedNote.note, 'utf8');
  const signatureOk = parsedNote.signatures.some((signature) => {
    if (!signature.keyHint.equals(logIdBytes.subarray(0, 4))) return false;
    try {
      return sigstoreCrypto.verify(noteData, publicKey as never, signature.signature) as boolean;
    } catch {
      return false;
    }
  });
  if (!signatureOk) return { verified: false, error: 'invalid checkpoint signature' };

  const lines = parsedNote.note.trimEnd().split('\n');
  if (lines.length < 3) return { verified: false, error: 'too few lines in checkpoint header' };
  let logSize: bigint;
  try {
    logSize = BigInt(lines[1] ?? '');
  } catch {
    return { verified: false, error: 'invalid checkpoint log size' };
  }
  const logHash = Buffer.from(lines[2] ?? '', 'base64');

  let proofIndex: bigint;
  try {
    proofIndex = BigInt(inclusionProof.logIndex);
  } catch {
    return { verified: false, error: 'invalid inclusion proof log index' };
  }
  if (proofIndex < 0n || proofIndex >= logSize) {
    return { verified: false, error: 'inclusion proof index outside the checkpoint tree' };
  }
  const inner = bitLength(proofIndex ^ (logSize - 1n));
  const border = onesCount(proofIndex >> BigInt(inner));
  const proofHashes = inclusionProof.hashes;
  if (!Array.isArray(proofHashes)) {
    return { verified: false, error: 'inclusion proof carries no hash list' };
  }
  if (proofHashes.length !== inner + border) {
    return { verified: false, error: 'inclusion proof hash count does not match the tree shape' };
  }
  const leafHash = createHash('sha256').update(RFC6962_LEAF_HASH_PREFIX).update(input.entry.canonicalizedBody).digest();
  const innerHashes = proofHashes.slice(0, inner);
  const borderHashes = proofHashes.slice(inner);
  const calculatedHash = chainBorderRight(chainInner(leafHash, innerHashes, proofIndex), borderHashes);
  if (!calculatedHash.equals(logHash)) {
    return { verified: false, error: 'calculated root hash does not match the checkpoint' };
  }
  return { verified: true, logSize, logHash };
}

function signatureDigestAlgorithm(key: KeyObject): string | null | undefined {
  switch (key.asymmetricKeyType) {
    case 'ed25519':
    case 'ed448':
      return null; // node signs/verifies with a null digest for EdDSA
    case 'rsa':
    case 'rsa-pss':
      return 'sha256';
    case 'ec': {
      const curve = key.asymmetricKeyDetails?.namedCurve;
      return curve === 'secp384r1' ? 'sha384' : 'sha256';
    }
    default:
      return undefined; // unsupported key type
  }
}

export function verifyKeylessBundle(input: {
  bundle: unknown;
  signed_bytes?: Buffer | undefined;
  policy?: KeylessTrustPolicy | null | undefined;
  at?: Date | undefined;
  // Attach paths pass the live clock here: the certificate chain must also be
  // valid at this instant, so an authenticated tlog anchor can never mask a
  // certificate that is already expired when the registry witnesses it.
  require_valid_at?: Date | undefined;
}): KeylessVerificationResult {
  const at = input.at ?? new Date();
  const fail = (
    failure_kind: KeylessVerificationFailureKind,
    error: string,
  ): KeylessVerificationResult => ({ verified: false, failure_kind, error });
  const policy = input.policy;
  if (!policy || policy.trusted_root_pems.length === 0) {
    return fail('not_configured', 'keyless trust policy is not configured');
  }
  if (policy.allowed_issuers.length === 0 || policy.allowed_subject_patterns.length === 0) {
    return fail('not_configured', 'keyless trust policy is missing allowed issuers or subject patterns');
  }

  let bundle: Bundle;
  try {
    bundle = bundleFromJSON(input.bundle as never);
  } catch (err) {
    return fail(
      'invalid_bundle',
      `bundle is not a valid sigstore bundle: ${err instanceof Error ? err.message : 'parse error'}`,
    );
  }

  const chain = bundleCertificateChain(bundle);
  if (chain.length === 0) return fail('invalid_bundle', 'bundle does not carry an X.509 certificate');
  const leaf = chain[0] as ParsedCertificate;
  if (leaf.cert.isCA) return fail('untrusted_certificate', 'signing certificate must not be a CA');

  const trusted = policy.trusted_root_pems.flatMap(parsePemCertificates);
  if (trusted.length === 0) return fail('not_configured', 'keyless trust policy has no usable trusted roots');

  // Build the chain from the leaf to a configured trusted root: every hop
  // must link by issuer/subject and verify cryptographically; the terminal
  // certificate must equal a trusted root.
  const pool = [...chain.slice(1), ...trusted];
  const path: ParsedCertificate[] = [leaf];
  let current = leaf;
  let resolved = false;
  for (let depth = 0; depth < 10; depth += 1) {
    if (trusted.some((root) => current.cert.equals(root.cert))) {
      resolved = true;
      break;
    }
    const issuer = pool.find(
      (candidate) =>
        current.cert.issuer.equals(candidate.cert.subject) && current.cert.verify(candidate.cert),
    );
    if (!issuer) return fail('untrusted_certificate', 'certificate chain does not resolve to a trusted root');
    if (!issuer.cert.isCA) return fail('untrusted_certificate', 'certificate chain contains a non-CA issuer');
    path.push(issuer);
    current = issuer;
  }
  if (!resolved) return fail('untrusted_certificate', 'certificate chain does not resolve to a trusted root');

  const identity = leaf.cert.subjectAltName;
  if (!identity) return fail('identity_policy_failed', 'signing certificate has no subject alternative name');
  const issuer = oidcIssuerFromCertificate(leaf.cert);
  if (!issuer) return fail('identity_policy_failed', 'signing certificate has no OIDC issuer extension');
  if (!policy.allowed_issuers.includes(issuer)) {
    return fail(
      'identity_policy_failed',
      `OIDC issuer is not allowed by the keyless trust policy: ${issuer}`,
    );
  }
  const subjectAllowed = policy.allowed_subject_patterns.some((pattern) => {
    try {
      return new RegExp(pattern).test(identity);
    } catch {
      return false;
    }
  });
  if (!subjectAllowed) {
    return fail('identity_policy_failed', 'certificate identity is not allowed by the keyless trust policy');
  }

  let keyObject: KeyObject;
  try {
    keyObject = createPublicKey({ key: leaf.cert.publicKey, format: 'der', type: 'spki' });
  } catch {
    return fail('unsupported_key', 'signing certificate public key could not be parsed');
  }
  const digestAlgorithm = signatureDigestAlgorithm(keyObject);
  if (digestAlgorithm === undefined) {
    return fail('unsupported_key', 'signing certificate key type is not supported');
  }

  // Transparency-log anchoring: a bundle carrying transparency-log material
  // must be verifiable against the configured Rekor log. The signed entry
  // timestamp is authoritative whenever present - it is the only structure
  // that covers integratedTime - and real Rekor v1 bundles carry both a
  // promise and an inclusion proof. Certificate validity is anchored at
  // integratedTime only when that time is authenticated and the entry is
  // bound to the signed payload; otherwise the fallback time is used.
  const bundleSignature =
    bundle.content.$case === 'messageSignature'
      ? Buffer.from(bundle.content.messageSignature.signature)
      : undefined;
  const tlogEntry = bundle.verificationMaterial.tlogEntries[0];
  let effectiveAt = at;
  let tlog: KeylessTLogVerification | undefined;
  if (tlogEntry) {
    if (!policy.rekor_public_key_pem || !policy.rekor_log_id) {
      return fail(
        'tlog_not_configured',
        'bundle carries a transparency log inclusion promise but no Rekor trust policy is configured',
      );
    }
    const logIdHex = Buffer.from(tlogEntry.logId.keyId).toString('hex');
    if (logIdHex.toLowerCase() !== policy.rekor_log_id.toLowerCase()) {
      return fail(
        'tlog_inclusion_promise_failed',
        'transparency entry log id does not match the configured Rekor log',
      );
    }
    const entry = tlogEntry as unknown as ParsedTLogEntry;
    // The signed entry timestamp authenticates integratedTime; verify it
    // whenever the bundle carries one, independently of any inclusion proof.
    const signedEntryTimestamp = entry.inclusionPromise?.signedEntryTimestamp;
    let integratedTimeAuthenticated = false;
    if (signedEntryTimestamp) {
      const setOutcome = verifySignedEntryTimestamp({
        entry: {
          canonicalizedBody: entry.canonicalizedBody,
          integratedTime: entry.integratedTime,
          logIndex: entry.logIndex,
          logId: { keyId: entry.logId.keyId },
          inclusionPromise: { signedEntryTimestamp },
        },
        rekorPublicKeyPem: policy.rekor_public_key_pem,
      });
      if (!setOutcome.verified) {
        return fail('tlog_inclusion_promise_failed', setOutcome.error ?? 'inclusion promise verification failed');
      }
      integratedTimeAuthenticated = true;
    }
    if (entry.inclusionProof) {
      const proofOutcome = verifyCheckpointAndInclusion({
        entry,
        rekorPublicKeyPem: policy.rekor_public_key_pem,
        logIdHex,
      });
      if (!proofOutcome.verified) {
        return fail('tlog_inclusion_promise_failed', proofOutcome.error ?? 'inclusion proof verification failed');
      }
    } else if (!integratedTimeAuthenticated) {
      return fail(
        'tlog_inclusion_promise_failed',
        'transparency entry carries neither an inclusion proof nor a signed entry timestamp',
      );
    }
    const bodyBound = input.signed_bytes
      ? hashedRekordBindsPayload({
          canonicalizedBody: tlogEntry.canonicalizedBody,
          signedBytes: input.signed_bytes,
          signatureFromBundle: bundleSignature,
        }).bound
      : false;
    const integratedSeconds = Number(tlogEntry.integratedTime);
    const integratedValid = Number.isFinite(integratedSeconds) && integratedSeconds > 0;
    const integratedTimeVerified = integratedTimeAuthenticated && integratedValid;
    tlog = {
      present: true,
      verified: true,
      body_bound: bodyBound,
      integrated_time_verified: integratedTimeVerified,
      ...(integratedValid ? { log_index: Number(tlogEntry.logIndex) } : {}),
      ...(integratedValid ? { integrated_time: new Date(integratedSeconds * 1000).toISOString() } : {}),
    };
    if (bodyBound && integratedTimeVerified) {
      effectiveAt = new Date(integratedSeconds * 1000);
    }
  }

  const validityInstants = input.require_valid_at ? [effectiveAt, input.require_valid_at] : [effectiveAt];
  if (!path.every((entry) => validityInstants.every((instant) => entry.cert.validForDate(instant)))) {
    return {
      ...fail('expired_certificate', 'certificate chain is not valid at verification time'),
      ...(tlog ? { tlog } : {}),
    };
  }

  const result: KeylessVerificationResult = {
    verified: true,
    identity,
    issuer,
    algorithm: keylessAlgorithmLabel(keyObject),
    certificate_chain_pem: path.map((entry) => entry.pem).join(''),
    validity_evaluated_at: effectiveAt.toISOString(),
    ...(tlog ? { tlog } : {}),
  };

  // Verified means chain AND signature: without the signed payload bytes the
  // message digest and signature cannot be checked, so fail closed instead of
  // presenting chain-only checks as a verification result.
  if (!input.signed_bytes) {
    return {
      ...result,
      verified: false,
      failure_kind: 'signature_not_checked',
      error: 'signed payload bytes are required to verify the signature',
    };
  }

  if (bundle.content.$case !== 'messageSignature') {
    return { ...result, verified: false, failure_kind: 'invalid_bundle', error: 'bundle does not carry a message signature' };
  }
  const messageSignature = bundle.content.messageSignature;
  const digest = createHash('sha256').update(input.signed_bytes).digest();
  const bundleDigest = Buffer.from(messageSignature.messageDigest.digest);
  if (messageSignature.messageDigest.algorithm !== HashAlgorithm.SHA2_256 || !bundleDigest.equals(digest)) {
    return { ...result, verified: false, failure_kind: 'digest_mismatch', error: 'signature digest does not match the signed payload' };
  }
  const signatureBytes = Buffer.from(messageSignature.signature);
  const verified = verifySignature(digestAlgorithm, input.signed_bytes, keyObject, signatureBytes);
  if (!verified) {
    return { ...result, verified: false, failure_kind: 'cryptographic_failure', error: 'signature does not verify over the signed payload' };
  }
  return result;
}
