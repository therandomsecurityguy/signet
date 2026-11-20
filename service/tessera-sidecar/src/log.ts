import { createHash, createPublicKey, createPrivateKey, sign as signBytes } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

// Native RFC 6962 companion log: append leaves (canonical append-intent
// record bytes), maintain the tree state, and publish supervised
// checkpoints. Two signing modes produce the same envelope shape
// (`<origin>\n<size>\n<base64 root>\n\n— <name> <base64(hint||sig)>\n`):
// - PEM (legacy): hint = sha256(SPKI DER)[:4], signature via
//   `sign('sha256', ...)`; verification lives in the registry
//   (transparency-notes.ts) and mirrors the construction.
// - NOTE (transparency-dev spec): the signer is a `PRIVATE+KEY+...` Ed25519
//   note key, the hint is the name-bound spec key hash
//   (bigendian32(SHA256(name + "\n" + 0x01||pubkey))), and the signature is
//   pure Ed25519 over the note body — byte-identical to golang's
//   x/mod/sumdb/note output for the same key (fixture-verified).

export function rfc6962LeafHash(leafPayload: string): Buffer {
  return createHash('sha256')
    .update(Buffer.concat([Buffer.from([0x00]), Buffer.from(leafPayload, 'utf8')]))
    .digest();
}

export function rfc6962NodeHash(left: Uint8Array, right: Uint8Array): Buffer {
  return createHash('sha256')
    .update(Buffer.concat([Buffer.from([0x01]), Buffer.from(left), Buffer.from(right)]))
    .digest();
}

function largestPowerOfTwoLessThan(n: number): number {
  let k = 1;
  while (k < n) k <<= 1;
  return k >> 1;
}

function computeSubtreeRoot(leaves: Buffer[], start: number, end: number): Buffer {
  const n = end - start;
  if (n === 1) return leaves[start] as Buffer;
  const k = largestPowerOfTwoLessThan(n);
  return rfc6962NodeHash(
    computeSubtreeRoot(leaves, start, start + k),
    computeSubtreeRoot(leaves, start + k, end),
  );
}

export function computeMerkleRoot(leafHashes: Buffer[]): Buffer {
  if (leafHashes.length === 0) {
    throw new Error('Cannot compute a Merkle root over an empty tree.');
  }
  return computeSubtreeRoot(leafHashes, 0, leafHashes.length);
}

function buildAuditPath(
  leaves: Buffer[],
  start: number,
  end: number,
  index: number,
  path: Buffer[],
): void {
  const n = end - start;
  if (n === 1) return;
  const k = largestPowerOfTwoLessThan(n);
  if (index < start + k) {
    buildAuditPath(leaves, start, start + k, index, path);
    path.push(computeSubtreeRoot(leaves, start + k, end));
  } else {
    buildAuditPath(leaves, start + k, end, index, path);
    path.push(computeSubtreeRoot(leaves, start, k + start));
  }
}

export function generateInclusionProof(leafHashes: Buffer[], leafIndex: number): Buffer[] {
  if (leafIndex < 0 || leafIndex >= leafHashes.length) {
    throw new Error(`Leaf index out of range: ${leafIndex} (tree size ${leafHashes.length})`);
  }
  const path: Buffer[] = [];
  buildAuditPath(leafHashes, 0, leafHashes.length, leafIndex, path);
  return path;
}

/**
 * RFC 6962 Merkle hash over a contiguous range of leaf hashes (a node at
 * tree level log2(end-start) when the range is a power-of-two-aligned
 * subtree). Used by the tlog-tiles layout to materialize tile rows.
 */
export function merkleRootOfRange(leafHashes: Buffer[], start: number, end: number): Buffer {
  if (start < 0 || end > leafHashes.length || start >= end) {
    throw new Error(`Leaf range out of bounds: [${start}, ${end}) with ${leafHashes.length} leaves`);
  }
  return computeSubtreeRoot(leafHashes, start, end);
}

export function keyHintForPrivateKey(privateKey: KeyObject): Buffer {
  const spkiDer = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(spkiDer).digest().subarray(0, 4);
}

export type BuiltCheckpoint = {
  envelope: string;
  note: string;
  noteSha256: string;
  treeSize: number;
  rootHashHex: string;
};

// Builds a transparency-dev signed note for the current tree: the note body
// carries the origin, tree size, and base64 root; the signature line carries
// the key hint and an ECDSA/RSA signature over the note body bytes.
export function buildSignedCheckpoint(input: {
  origin: string;
  privateKeyPem: string;
  treeSize: number;
  rootHash: Buffer;
}): BuiltCheckpoint {
  const privateKey = createPrivateKey(input.privateKeyPem);
  const note = `${input.origin}\n${input.treeSize}\n${input.rootHash.toString('base64')}\n`;
  const signature = signBytes('sha256', Buffer.from(note, 'utf8'), privateKey);
  const hint = keyHintForPrivateKey(privateKey);
  const envelope = `${note}\n\u2014 ${input.origin} ${Buffer.concat([hint, signature]).toString('base64')}\n`;
  return {
    envelope,
    note,
    noteSha256: createHash('sha256').update(Buffer.from(envelope, 'utf8')).digest('hex'),
    treeSize: input.treeSize,
    rootHashHex: input.rootHash.toString('hex'),
  };
}

const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const NOTE_ALG_ED25519 = 0x01;

export class NoteSignerKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoteSignerKeyError';
  }
}

export type NoteSigner = {
  name: string;
  keyHash: Buffer;
  keyHashHex: string;
  privateKey: KeyObject;
};

/**
 * Strict parser for spec signer keys (`PRIVATE+KEY+<name>+<hash8hex>+<base64>`):
 * the base64 key data is `0x01 || 32-byte Ed25519 seed`, and the hash is
 * recomputed over the derived public key (a mismatched hash fails closed).
 */
export function parseNoteSignerKey(signerKey: string): NoteSigner {
  if (!signerKey.startsWith('PRIVATE+KEY+')) {
    throw new NoteSignerKeyError('note signer key must start with PRIVATE+KEY+');
  }
  const parts = signerKey.slice('PRIVATE+KEY+'.length).split('+');
  if (parts.length < 3) {
    throw new NoteSignerKeyError('note signer key must be PRIVATE+KEY+<name>+<hash8hex>+<base64>');
  }
  const name = parts[0] ?? '';
  const hashHex = parts[1] ?? '';
  // The base64 key data may contain '+', so only the first two separators
  // after the prefix are cut.
  const key64 = parts.slice(2).join('+');
  if (!name || /\s/u.test(name)) {
    throw new NoteSignerKeyError('note signer name must be non-empty with no spaces');
  }
  if (!/^[0-9a-f]{8}$/.test(hashHex)) {
    throw new NoteSignerKeyError('note signer hash must be 8 lowercase hex characters');
  }
  const keyData = Buffer.from(key64, 'base64');
  if (keyData.toString('base64') !== key64) {
    throw new NoteSignerKeyError('note signer key data must be standard base64');
  }
  if (keyData.length !== 1 + 32 || keyData[0] !== NOTE_ALG_ED25519) {
    throw new NoteSignerKeyError('note signer key must be Ed25519 (algorithm byte 0x01, 32-byte seed)');
  }
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, keyData.subarray(1)]),
    format: 'der',
    type: 'pkcs8',
  });
  const spkiDer = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const publicKey = spkiDer.subarray(spkiDer.length - 32);
  const keyHash = createHash('sha256')
    .update(name)
    .update('\n')
    .update(Buffer.concat([Buffer.from([NOTE_ALG_ED25519]), publicKey]))
    .digest()
    .subarray(0, 4);
  if (keyHash.toString('hex') !== hashHex) {
    throw new NoteSignerKeyError('note signer hash does not match the key');
  }
  return { name, keyHash, keyHashHex: hashHex, privateKey };
}

/** Spec note checkpoint: pure Ed25519 over the note body, name-bound hint. */
export function buildSignedNoteCheckpoint(input: {
  noteKey: string;
  treeSize: number;
  rootHash: Buffer;
}): BuiltCheckpoint {
  const signer = parseNoteSignerKey(input.noteKey);
  const note = `${signer.name}\n${input.treeSize}\n${input.rootHash.toString('base64')}\n`;
  const signature = signBytes(null, Buffer.from(note, 'utf8'), signer.privateKey);
  const envelope = `${note}\n\u2014 ${signer.name} ${Buffer.concat([signer.keyHash, signature]).toString('base64')}\n`;
  return {
    envelope,
    note,
    noteSha256: createHash('sha256').update(Buffer.from(envelope, 'utf8')).digest('hex'),
    treeSize: input.treeSize,
    rootHashHex: input.rootHash.toString('hex'),
  };
}

export type CheckpointSigner = { kind: 'pem'; privateKeyPem: string } | { kind: 'note'; noteKey: string };

export function buildCheckpointForSigner(input: {
  signer: CheckpointSigner;
  origin: string;
  treeSize: number;
  rootHash: Buffer;
}): BuiltCheckpoint {
  if (input.signer.kind === 'note') {
    // The note name is authoritative for spec notes (boot-time validation
    // pins it to TESSERA_LOG_ORIGIN).
    return buildSignedNoteCheckpoint({
      noteKey: input.signer.noteKey,
      treeSize: input.treeSize,
      rootHash: input.rootHash,
    });
  }
  return buildSignedCheckpoint({
    origin: input.origin,
    privateKeyPem: input.signer.privateKeyPem,
    treeSize: input.treeSize,
    rootHash: input.rootHash,
  });
}
