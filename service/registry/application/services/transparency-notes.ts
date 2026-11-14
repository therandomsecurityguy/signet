import { createHash } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

import { crypto as sigstoreCrypto } from '@sigstore/core';

// Signed-note checkpoints and RFC 6962 inclusion proofs shared by every
// external-log verifier (Rekor anchoring and Tessera reconciliation). The
// note format is the transparency-dev signed-note format:
//   <origin>\n<tree size>\n<base64 root hash>\n\n— <name> <base64(hint||sig)>\n
// where the hint is the first 4 bytes of the log id and signatures cover the
// note body bytes.

const CHECKPOINT_SEPARATOR = '\n\n';
const CHECKPOINT_SIGNATURE_REGEX = /\u2014 (\S+) (\S+)\n/g;

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

// Verifies that at least one signature in the signed note matches the
// expected key hint and validates against the trusted public key. The
// signature name is informational and deliberately not trusted.
export function verifySignedNote(input: {
  envelope: string;
  publicKeyPem: string;
  keyHintSource: Buffer;
}): { verified: boolean; note?: string; error?: string } {
  const parsed = parseSignedNote(input.envelope);
  if (!parsed) return { verified: false, error: 'malformed checkpoint note' };
  let publicKey: KeyObject;
  try {
    publicKey = sigstoreCrypto.createPublicKey(input.publicKeyPem) as unknown as KeyObject;
  } catch {
    return { verified: false, error: 'configured log public key could not be parsed' };
  }
  const noteData = Buffer.from(parsed.note, 'utf8');
  const expectedHint = input.keyHintSource.subarray(0, 4);
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
