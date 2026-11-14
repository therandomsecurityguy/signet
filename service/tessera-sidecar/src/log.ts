import { createHash, createPublicKey, createPrivateKey, sign as signBytes } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

// Native RFC 6962 companion log: append leaves (canonical append-intent
// record bytes), maintain the tree state, and publish supervised
// checkpoints as transparency-dev signed notes. Verification lives in the
// registry (transparency-notes.ts) and mirrors these constructions:
// leaf 0x00 / node 0x01 domain separation, note-body signatures with a
// 4-byte key hint (sha256 of the SPKI DER).

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
