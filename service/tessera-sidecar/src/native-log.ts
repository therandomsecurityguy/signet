import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';

import { buildCheckpointForSigner, computeMerkleRoot, generateInclusionProof, merkleRootOfRange, rfc6962LeafHash } from './log.js';
import type { CheckpointSigner } from './log.js';

const TLOG_TILE_WIDTH = 256;
const TLOG_TILE_HEIGHT = 8;

export type S3Like = {
  send(command: unknown): Promise<unknown>;
};

export type NativeLogEntry = {
  entry_index: number;
  request_id: string;
  record_key: string;
  record_sha256: string;
  leaf_hash: string;
  created_at: string;
};

export type NativeLogState = {
  tree_size: number;
  root_hash: string;
  updated_at: string;
};

// Single-writer storage layout under the tiles prefix:
//   <prefix>/<log_id>/state.json            tree size + current root
//   <prefix>/<log_id>/leaves/<0000000000>.json  leaf hash + record pointer
// Append is read-state -> write-leaf -> write-state; the sidecar runs as a
// single writer, so proofs and checkpoints derived from the leaf list are
// consistent with the last completed append.
export class NativeLog {
  constructor(
    private readonly s3: S3Like,
    private readonly bucket: string,
    private readonly tilesPrefix: string,
    private readonly requestsPrefix: string,
  ) {}

  private base(logId: string): string {
    return `${trimSlashes(this.tilesPrefix)}/${sanitize(logId)}`;
  }

  async readState(logId: string): Promise<NativeLogState | null> {
    try {
      const output = await this.s3.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: `${this.base(logId)}/state.json` }),
      );
      return JSON.parse(await readBodyText(output)) as NativeLogState;
    } catch {
      return null;
    }
  }

  async listLeaves(logId: string): Promise<NativeLogEntry[]> {
    const output = (await this.s3.send(
      new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: `${this.base(logId)}/leaves/`,
      }),
    )) as { Contents?: Array<{ Key?: string }> };
    const keys = (output.Contents ?? [])
      .map((entry) => entry.Key ?? '')
      .filter((key) => key.endsWith('.json'))
      .sort();
    const leaves: NativeLogEntry[] = [];
    for (const key of keys) {
      const item = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      leaves.push(JSON.parse(await readBodyText(item)) as NativeLogEntry);
    }
    return leaves;
  }

  async append(input: {
    logId: string;
    requestId: string;
    record: string;
    recordKey: string;
    recordSha256: string;
    createdAt: string;
  }): Promise<{ state: NativeLogState; entryIndex: number; leafHash: string }> {
    const leaves = await this.listLeaves(input.logId);
    const entryIndex = leaves.length;
    const leafHash = rfc6962LeafHash(input.record);
    const entry: NativeLogEntry = {
      entry_index: entryIndex,
      request_id: input.requestId,
      record_key: input.recordKey,
      record_sha256: input.recordSha256,
      leaf_hash: leafHash.toString('hex'),
      created_at: input.createdAt,
    };
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: `${this.base(input.logId)}/leaves/${String(entryIndex).padStart(10, '0')}.json`,
        Body: Buffer.from(JSON.stringify(entry), 'utf8'),
        ContentType: 'application/json',
      }),
    );
    const rootHash = computeMerkleRoot([...leaves.map((leaf) => Buffer.from(leaf.leaf_hash, 'hex')), leafHash]);
    const state: NativeLogState = {
      tree_size: entryIndex + 1,
      root_hash: rootHash.toString('hex'),
      updated_at: input.createdAt,
    };
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: `${this.base(input.logId)}/state.json`,
        Body: Buffer.from(JSON.stringify(state), 'utf8'),
        ContentType: 'application/json',
      }),
    );
    return { state, entryIndex, leafHash: leafHash.toString('hex') };
  }

  async entry(input: {
    logId: string;
    index: number;
    checkpointOrigin: string;
    checkpointSigner: CheckpointSigner;
  }): Promise<{
    entry: NativeLogEntry;
    proof: { tree_size: number; root_hash: string; hashes: string[] };
    checkpoint: { envelope: string; note_sha256: string };
    record_b64: string;
  } | null> {
    const leaves = await this.listLeaves(input.logId);
    const entry = leaves.find((leaf) => leaf.entry_index === input.index);
    if (!entry) return null;
    // Confine record reads to the requests prefix: leaf objects are data, so
    // a tampered leaf must never be able to redirect the read to an
    // arbitrary bucket key (path traversal / cross-object disclosure).
    const allowedRecordPrefix = `${trimSlashes(this.requestsPrefix)}/`;
    if (!entry.record_key.startsWith(allowedRecordPrefix)) return null;
    const state = await this.readState(input.logId);
    if (!state) return null;
    const leafHashes = leaves.map((leaf) => Buffer.from(leaf.leaf_hash, 'hex'));
    const proofHashes = generateInclusionProof(leafHashes, input.index);
    const rootHash = Buffer.from(state.root_hash, 'hex');
    const checkpoint = buildCheckpointForSigner({
      origin: input.checkpointOrigin,
      signer: input.checkpointSigner,
      treeSize: state.tree_size,
      rootHash,
    });
    const record = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: entry.record_key }));
    return {
      entry,
      proof: {
        tree_size: state.tree_size,
        root_hash: state.root_hash,
        hashes: proofHashes.map((hash) => hash.toString('hex')),
      },
      checkpoint: { envelope: checkpoint.envelope, note_sha256: checkpoint.noteSha256 },
      record_b64: Buffer.from(await readBodyText(record), 'utf8').toString('base64'),
    };
  }

  async listLogIds(): Promise<string[]> {
    const output = (await this.s3.send(
      new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: `${trimSlashes(this.tilesPrefix)}/`,
        Delimiter: '/',
      }),
    )) as { CommonPrefixes?: Array<{ Prefix?: string }> };
    return (output.CommonPrefixes ?? [])
      .map((prefix) => (prefix.Prefix ?? '').replace(/\/$/, '').split('/').pop() ?? '')
      .filter(Boolean);
  }

  /**
   * tlog-tiles hash tile (C2SP layout): the row of node hashes at tree level
   * `level * 8` for tile `index`. Level-0 nodes are the stored leaf hashes;
   * higher levels are RFC 6962 subtree roots over 2^(8*level) leaves.
   * Returns null for tiles that do not exist at the current tree size, and
   * for stale partial widths (`partial` must be the CURRENT rightmost
   * partial size; 0 means a full tile and requires the tile to be complete).
   */
  async hashTile(logId: string, level: number, index: number, partial: number): Promise<Buffer | null> {
    const state = await this.readState(logId);
    if (!state) return null;
    const sizeAtLevel = Math.floor(state.tree_size / 2 ** (level * TLOG_TILE_HEIGHT));
    const fullTiles = Math.floor(sizeAtLevel / TLOG_TILE_WIDTH);
    let width: number;
    if (partial === 0) {
      if (index >= fullTiles) return null;
      width = TLOG_TILE_WIDTH;
    } else {
      if (index !== fullTiles || partial !== sizeAtLevel % TLOG_TILE_WIDTH) return null;
      width = partial;
    }
    const leaves = await this.listLeaves(logId);
    if (leaves.length !== state.tree_size) return null;
    const leafHashes = leaves.map((leaf) => Buffer.from(leaf.leaf_hash, 'hex'));
    const span = 2 ** (level * TLOG_TILE_HEIGHT);
    const nodes: Buffer[] = [];
    for (let offset = 0; offset < width; offset += 1) {
      const start = (index * TLOG_TILE_WIDTH + offset) * span;
      nodes.push(merkleRootOfRange(leafHashes, start, start + span));
    }
    return Buffer.concat(nodes);
  }

  /**
   * tlog-tiles entry bundle: up to 256 leaf DATA records, each prefixed with
   * its length as a big-endian uint16 (C2SP layout; verified against the
   * transparency-dev EntryBundle parser). Our leaf data is the canonical
   * append-intent record bytes. Partial validation mirrors `hashTile`.
   */
  async entriesTile(logId: string, index: number, partial: number): Promise<Buffer | null> {
    const state = await this.readState(logId);
    if (!state) return null;
    const fullTiles = Math.floor(state.tree_size / TLOG_TILE_WIDTH);
    let width: number;
    if (partial === 0) {
      if (index >= fullTiles) return null;
      width = TLOG_TILE_WIDTH;
    } else {
      if (index !== fullTiles || partial !== state.tree_size % TLOG_TILE_WIDTH) return null;
      width = partial;
    }
    const leaves = await this.listLeaves(logId);
    if (leaves.length !== state.tree_size) return null;
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < width; offset += 1) {
      const leaf = leaves[index * TLOG_TILE_WIDTH + offset] as NativeLogEntry;
      const record = await this.s3
        .send(new GetObjectCommand({ Bucket: this.bucket, Key: leaf.record_key }))
        .catch(() => null);
      if (!record) return null;
      const data = Buffer.from(await readBodyText(record), 'utf8');
      if (data.length > 0xffff) return null;
      const prefix = Buffer.alloc(2);
      prefix.writeUInt16BE(data.length, 0);
      chunks.push(prefix, data);
    }
    return Buffer.concat(chunks);
  }
}

async function readBodyText(output: unknown): Promise<string> {
  const body = (output as { Body?: unknown }).Body;
  if (body === undefined || body === null) return '';
  if (typeof body === 'string') return body;
  if (Buffer.isBuffer(body)) return body.toString('utf8');
  const stream = body as { transformToString?: () => Promise<string> };
  if (typeof stream.transformToString === 'function') {
    return await stream.transformToString();
  }
  return String(body);
}

function sanitize(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-');
}

function trimSlashes(value: string) {
  return value.replace(/^\/+|\/+$/g, '');
}
