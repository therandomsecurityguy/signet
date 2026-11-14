/**
 * Internal append-only Merkle log (RFC 6962 / Certificate Transparency
 * style) for registry governance events.
 *
 * The registry appends every lifecycle governance event (validate,
 * publish, certify, promote/supersede, deprecate, revoke, archive) as a
 * leaf in a single append-only Merkle tree. Leaf payloads are the
 * canonical (RFC 8785 JCS) event JSON bytes; leaf and node hashes follow
 * RFC 6962 domain separation (0x00 leaf prefix, 0x01 node prefix).
 *
 * This module provides the generation side — tree roots and inclusion
 * proofs — complementing the verification side already implemented for
 * external transparency logs. Generated proofs verify with the existing
 * RFC 6962 inclusion-proof verifier.
 */

import { createHash } from 'node:crypto';

export function rfc6962LeafHash(leafPayload: string): Buffer {
  return createHash('sha256').update(Buffer.concat([Buffer.from([0x00]), Buffer.from(leafPayload, 'utf8')])).digest();
}

export function rfc6962NodeHash(left: Uint8Array, right: Uint8Array): Buffer {
  return createHash('sha256').update(Buffer.concat([Buffer.from([0x01]), Buffer.from(left), Buffer.from(right)])).digest();
}

/** Largest power of 2 strictly smaller than n (n >= 2). */
function largestPowerOfTwoLessThan(n: number): number {
  let k = 1;
  while (k < n) k <<= 1;
  return k >> 1;
}

/** Compute the RFC 6962 Merkle tree root over hex-encoded leaf hashes. */
export function computeMerkleRoot(leafHashes: string[]): string {
  if (leafHashes.length === 0) {
    throw new Error('Cannot compute a Merkle root over an empty tree.');
  }
  return Buffer.from(computeSubtreeRoot(leafHashes.map((h) => Buffer.from(h, 'hex')), 0, leafHashes.length)).toString('hex');
}

function computeSubtreeRoot(leaves: Buffer[], start: number, end: number): Buffer {
  const n = end - start;
  if (n === 1) return leaves[start] as Buffer;
  const k = largestPowerOfTwoLessThan(n);
  return rfc6962NodeHash(computeSubtreeRoot(leaves, start, start + k), computeSubtreeRoot(leaves, start + k, end));
}

/**
 * Generate the RFC 6962 audit path (inclusion proof) for the leaf at
 * `leafIndex` in a tree with the given ordered leaf hashes.
 */
export function generateInclusionProof(leafHashes: string[], leafIndex: number): string[] {
  if (leafIndex < 0 || leafIndex >= leafHashes.length) {
    throw new Error(`Leaf index out of range: ${leafIndex} (tree size ${leafHashes.length})`);
  }
  const leaves = leafHashes.map((h) => Buffer.from(h, 'hex'));
  const path: Buffer[] = [];
  buildAuditPath(leaves, 0, leaves.length, leafIndex, path);
  return path.map((h) => h.toString('hex'));
}

function buildAuditPath(leaves: Buffer[], start: number, end: number, index: number, path: Buffer[]): void {
  const n = end - start;
  if (n === 1) return;
  const k = largestPowerOfTwoLessThan(n);
  // The audit path is ordered from the leaf upward: recurse into the
  // subtree containing the leaf first, then append the sibling subtree hash.
  if (index < start + k) {
    buildAuditPath(leaves, start, start + k, index, path);
    path.push(computeSubtreeRoot(leaves, start + k, end));
  } else {
    buildAuditPath(leaves, start + k, end, index, path);
    path.push(computeSubtreeRoot(leaves, start, start + k));
  }
}
