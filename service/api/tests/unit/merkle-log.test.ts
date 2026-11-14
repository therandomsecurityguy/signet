import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';

import {
  computeMerkleRoot,
  generateInclusionProof,
  rfc6962LeafHash,
  rfc6962NodeHash,
} from '../../../registry/application/services/merkle-log.js';

/**
 * Standard RFC 6962 audit-path fold (mirrors the verifier in
 * default-registry-service.ts): the sibling is on the left when the
 * current node is a right child or the rightmost node of an incomplete
 * subtree.
 */
function foldProof(input: { leaf_hash: Buffer; leaf_index: number; tree_size: number; proof_hashes: string[] }): Buffer {
  let index = input.leaf_index;
  let last = input.tree_size - 1;
  let hash = input.leaf_hash;
  for (const sibling of input.proof_hashes) {
    const siblingBytes = Buffer.from(sibling.replace(/^hex:/, ''), 'hex');
    if ((index & 1) === 1 || index === last) {
      hash = rfc6962NodeHash(siblingBytes, hash);
    } else {
      hash = rfc6962NodeHash(hash, siblingBytes);
    }
    index >>= 1;
    last >>= 1;
  }
  return hash;
}

describe('internal Merkle log', () => {
  it('computes RFC 6962 leaf and node hashes with domain separation', () => {
    const leaf = rfc6962LeafHash('event');
    const manual = createHash('sha256').update(Buffer.concat([Buffer.from([0x00]), Buffer.from('event', 'utf8')])).digest();
    expect(leaf.equals(manual)).toBe(true);

    const node = rfc6962NodeHash(Buffer.from('a'), Buffer.from('b'));
    const manualNode = createHash('sha256')
      .update(Buffer.concat([Buffer.from([0x01]), Buffer.from('a'), Buffer.from('b')]))
      .digest();
    expect(node.equals(manualNode)).toBe(true);
  });

  it('computes the root of a single-leaf tree as the leaf hash', () => {
    const leaf = rfc6962LeafHash('only').toString('hex');
    expect(computeMerkleRoot([leaf])).toBe(leaf);
  });

  it('rejects an empty tree', () => {
    expect(() => computeMerkleRoot([])).toThrow(/empty tree/);
  });

  it('rejects out-of-range proof requests', () => {
    const leaves = [rfc6962LeafHash('a').toString('hex')];
    expect(() => generateInclusionProof(leaves, 1)).toThrow(/out of range/);
    expect(() => generateInclusionProof(leaves, -1)).toThrow(/out of range/);
  });

  it('generates inclusion proofs that fold to the root for all tree sizes 1..64', () => {
    for (let n = 1; n <= 64; n++) {
      const leaves = Array.from({ length: n }, (_, i) => rfc6962LeafHash(`event-${i}`).toString('hex'));
      const root = computeMerkleRoot(leaves);
      for (let i = 0; i < n; i++) {
        const proof = generateInclusionProof(leaves, i);
        const folded = foldProof({
          leaf_hash: Buffer.from(leaves[i] as string, 'hex'),
          leaf_index: i,
          tree_size: n,
          proof_hashes: proof,
        });
        expect(folded.toString('hex'), `n=${n} i=${i}`).toBe(root);
      }
    }
  });

  it('detects tampering: a mutated leaf no longer folds to the root', () => {
    const leaves = Array.from({ length: 5 }, (_, i) => rfc6962LeafHash(`event-${i}`).toString('hex'));
    const root = computeMerkleRoot(leaves);
    const proof = generateInclusionProof(leaves, 2);
    const mutated = rfc6962LeafHash('event-2-tampered');
    const folded = foldProof({ leaf_hash: mutated, leaf_index: 2, tree_size: 5, proof_hashes: proof });
    expect(folded.toString('hex')).not.toBe(root);
  });
});
