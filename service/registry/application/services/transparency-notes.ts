import { createHash, createPublicKey, verify as nodeVerify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

import { crypto as sigstoreCrypto } from '@sigstore/core';

// Signed-note checkpoints and RFC 6962 inclusion proofs shared by every
// external-log verifier (Rekor anchoring and Tessera reconciliation). The
// note format is the transparency-dev signed-note format:
//   <origin>\n<tree size>\n<base64 root hash>\n\n— <name> <base64(hint||sig)>\n
//
// Two key-identity conventions are supported:
// - SPEC (transparency-dev / x/mod sumdb/note, Ed25519-only): the 4-byte
//   hint is bigendian32(SHA256(name + "\n" + keyData)) with
//   keyData = 0x01 || pubkey; signatures are pure Ed25519 over the note
//   body; verifier keys are `<name>+<hash8hex>+<base64(keyData)>`.
// - LEGACY (this repo's native sidecar): hint = SHA256(SPKI DER)[:4],
//   ECDSA-SHA256 signatures via Node `sign('sha256', ...)`. Kept for
//   existing deployments and notes.

const CHECKPOINT_SEPARATOR = '\n\n';
const CHECKPOINT_SIGNATURE_REGEX = /\u2014 (\S+) (\S+)\n/g;

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const NOTE_ALG_ED25519 = 0x01;

export class NoteVerifierKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoteVerifierKeyError';
  }
}

/** Spec key hash: full SHA-256 over name + "\n" + keyData (hint = first 4 bytes). */
export function noteKeyHashBytes(name: string, keyData: Buffer): Buffer {
  return createHash('sha256').update(name).update('\n').update(keyData).digest();
}

/**
 * Ed25519 public key as spec keyData (0x01 || 32-byte key) when the PEM key
 * is Ed25519; null otherwise (legacy key — spec enforcement does not apply).
 */
export function noteKeyDataFromPem(publicKeyPem: string): Buffer | null {
  try {
    const key = createPublicKey(publicKeyPem);
    if (key.asymmetricKeyType !== 'ed25519') return null;
    const der = key.export({ type: 'spki', format: 'der' });
    if (
      der.length !== ED25519_SPKI_PREFIX.length + 32 ||
      !der.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
    ) {
      return null;
    }
    return Buffer.concat([Buffer.from([NOTE_ALG_ED25519]), der.subarray(ED25519_SPKI_PREFIX.length)]);
  } catch {
    return null;
  }
}

export type ParsedNoteVerifierKey = {
  name: string;
  keyHash: Buffer;
  keyHashHex: string;
  publicKey: KeyObject;
};

/**
 * Strict parser for spec verifier keys (`<name>+<hash8hex>+<base64>`):
 * name rules per spec (non-empty, no Unicode spaces, no `+`), 8 lowercase
 * hex hash characters, standard base64 keyData with algorithm byte 0x01 and
 * a 32-byte Ed25519 key, and the hash recomputed over the decoded key.
 */
export function parseNoteVerifierKey(verifierKey: string): ParsedNoteVerifierKey {
  // Cut only the first two separators: the standard-base64 key data may
  // itself contain '+' (the spec forbids '+' in names for exactly this
  // reason), so a naive split would reject valid keys intermittently.
  const nameEnd = verifierKey.indexOf('+');
  const hashEnd = nameEnd >= 0 ? verifierKey.indexOf('+', nameEnd + 1) : -1;
  if (nameEnd <= 0 || hashEnd <= nameEnd + 1 || hashEnd >= verifierKey.length - 1) {
    throw new NoteVerifierKeyError('note verifier key must be <name>+<hash8hex>+<base64>');
  }
  const name = verifierKey.slice(0, nameEnd);
  const hashHex = verifierKey.slice(nameEnd + 1, hashEnd);
  const key64 = verifierKey.slice(hashEnd + 1);
  if (/\s/u.test(name)) {
    throw new NoteVerifierKeyError('note verifier name must be non-empty with no spaces or pluses');
  }
  if (!/^[0-9a-f]{8}$/.test(hashHex)) {
    throw new NoteVerifierKeyError('note verifier hash must be 8 lowercase hex characters');
  }
  const keyData = Buffer.from(key64, 'base64');
  if (keyData.toString('base64') !== key64) {
    throw new NoteVerifierKeyError('note verifier key data must be standard base64');
  }
  if (keyData.length !== 1 + 32 || keyData[0] !== NOTE_ALG_ED25519) {
    throw new NoteVerifierKeyError('note verifier key must be Ed25519 (algorithm byte 0x01, 32-byte key)');
  }
  const expectedHash = noteKeyHashBytes(name, keyData);
  if (expectedHash.subarray(0, 4).toString('hex') !== hashHex) {
    throw new NoteVerifierKeyError('note verifier hash does not match the key');
  }
  const publicKey = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, keyData.subarray(1)]),
    format: 'der',
    type: 'spki',
  });
  return { name, keyHash: expectedHash.subarray(0, 4), keyHashHex: hashHex, publicKey };
}

export type ParsedSignedNote = {
  note: string;
  signatures: Array<{ name: string; keyHint: Buffer; signature: Buffer }>;
};

export type ParsedCheckpoint = {
  origin: string;
  logSize: bigint;
  logHash: Buffer;
};

export function parseSignedNote(envelope: string): ParsedSignedNote | null {
  if (!envelope.includes(CHECKPOINT_SEPARATOR)) return null;
  const split = envelope.indexOf(CHECKPOINT_SEPARATOR);
  const note = envelope.slice(0, split + 1);
  const data = envelope.slice(split + CHECKPOINT_SEPARATOR.length);
  const signatures: ParsedSignedNote['signatures'] = [];
  for (const match of data.matchAll(CHECKPOINT_SIGNATURE_REGEX)) {
    const bytes = Buffer.from(match[2] ?? '', 'base64');
    if (bytes.length < 5) return null;
    signatures.push({
      name: match[1] ?? '',
      keyHint: bytes.subarray(0, 4),
      signature: bytes.subarray(4),
    });
  }
  return signatures.length > 0 ? { note, signatures } : null;
}

export type SignedNoteVerification = {
  verified: boolean;
  note?: string;
  error?: string;
  verifier?: { name: string; key_hash_hex: string };
};

/**
 * Verify a signed note. Two modes:
 * - SPEC: pass `note_verifier_key` — signatures are selected by (name, hash)
 *   per the transparency-dev spec and verified as pure Ed25519 over the note
 *   body.
 * - LEGACY: pass `public_key_pem` + `key_hint_source` — at least one
 *   signature whose 4-byte hint matches the expected SPKI-derived prefix
 *   must verify against the trusted PEM key (the signature name is
 *   informational and deliberately not trusted).
 */
export function verifySignedNote(input: {
  envelope: string;
  public_key_pem?: string;
  key_hint_source?: Buffer;
  note_verifier_key?: string;
}): SignedNoteVerification {
  const parsed = parseSignedNote(input.envelope);
  if (!parsed) return { verified: false, error: 'malformed checkpoint note' };

  if (input.note_verifier_key !== undefined) {
    let verifier: ParsedNoteVerifierKey;
    try {
      verifier = parseNoteVerifierKey(input.note_verifier_key);
    } catch (err) {
      return {
        verified: false,
        error: err instanceof Error ? err.message : 'configured note verifier key could not be parsed',
      };
    }
    const noteData = Buffer.from(parsed.note, 'utf8');
    const matched = parsed.signatures.filter(
      (signature) => signature.name === verifier.name && signature.keyHint.equals(verifier.keyHash),
    );
    if (matched.length === 0) {
      return { verified: false, error: 'checkpoint note carries no signature for the configured verifier key' };
    }
    const signatureOk = matched.some((signature) => {
      try {
        return nodeVerify(null, noteData, verifier.publicKey, signature.signature) as boolean;
      } catch {
        return false;
      }
    });
    if (!signatureOk) return { verified: false, error: 'invalid checkpoint signature' };
    return {
      verified: true,
      note: parsed.note,
      verifier: { name: verifier.name, key_hash_hex: verifier.keyHashHex },
    };
  }

  if (!input.public_key_pem || !input.key_hint_source) {
    return { verified: false, error: 'checkpoint verification requires a trusted key' };
  }
  let publicKey: KeyObject;
  try {
    publicKey = sigstoreCrypto.createPublicKey(input.public_key_pem) as unknown as KeyObject;
  } catch {
    return { verified: false, error: 'configured log public key could not be parsed' };
  }
  const noteData = Buffer.from(parsed.note, 'utf8');
  const expectedHint = input.key_hint_source.subarray(0, 4);
  const signatureOk = parsed.signatures.some((signature) => {
    if (!signature.keyHint.equals(expectedHint)) return false;
    try {
      return sigstoreCrypto.verify(noteData, publicKey as never, signature.signature) as boolean;
    } catch {
      return false;
    }
  });
  if (!signatureOk) return { verified: false, error: 'invalid checkpoint signature' };
  return { verified: true, note: parsed.note };
}

export function parseCheckpointNote(note: string): ParsedCheckpoint | null {
  const lines = note.trimEnd().split('\n');
  if (lines.length < 3) return null;
  let logSize: bigint;
  try {
    logSize = BigInt(lines[1] ?? '');
  } catch {
    return null;
  }
  return {
    origin: lines[0] ?? '',
    logSize,
    logHash: Buffer.from(lines[2] ?? '', 'base64'),
  };
}

export function keyHintForPublicKeyPem(publicKeyPem: string): Buffer | null {
  try {
    const key = sigstoreCrypto.createPublicKey(publicKeyPem) as unknown as KeyObject;
    const spkiDer = key.export({ type: 'spki', format: 'der' });
    return createHash('sha256').update(spkiDer).digest().subarray(0, 4);
  } catch {
    return null;
  }
}

const RFC6962_LEAF_HASH_PREFIX = Buffer.from([0x00]);
const RFC6962_NODE_HASH_PREFIX = Buffer.from([0x01]);

export function rfc6962LeafHashBytes(leaf: Uint8Array): Buffer {
  return createHash('sha256').update(RFC6962_LEAF_HASH_PREFIX).update(leaf).digest();
}

export function rfc6962NodeHashBytes(left: Uint8Array, right: Uint8Array): Buffer {
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
      return rfc6962NodeHashBytes(hash, acc);
    }
    return rfc6962NodeHashBytes(acc, hash);
  }, seed);
}

function chainBorderRight(seed: Buffer, hashes: Uint8Array[]): Buffer {
  return hashes.reduce<Buffer>((acc, hash) => rfc6962NodeHashBytes(hash, acc), seed);
}

// Verifies an RFC 6962 audit path: recomputes the tree root from the leaf
// hash and the proof hashes and compares it against the expected root.
export function verifyRfc6962Inclusion(input: {
  leafHash: Buffer;
  logIndex: bigint;
  treeSize: bigint;
  proofHashes: Uint8Array[];
  rootHash: Buffer;
}): { verified: boolean; error?: string } {
  if (input.logIndex < 0n || input.logIndex >= input.treeSize) {
    return { verified: false, error: 'inclusion proof index outside the tree' };
  }
  const inner = bitLength(input.logIndex ^ (input.treeSize - 1n));
  const border = onesCount(input.logIndex >> BigInt(inner));
  if (input.proofHashes.length !== inner + border) {
    return { verified: false, error: 'inclusion proof hash count does not match the tree shape' };
  }
  const innerHashes = input.proofHashes.slice(0, inner);
  const borderHashes = input.proofHashes.slice(inner);
  const calculated = chainBorderRight(chainInner(input.leafHash, innerHashes, input.logIndex), borderHashes);
  if (!calculated.equals(input.rootHash)) {
    return { verified: false, error: 'calculated root hash does not match the expected root' };
  }
  return { verified: true };
}
