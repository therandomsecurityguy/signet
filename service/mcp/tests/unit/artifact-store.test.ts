import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  FsCasArtifactStore,
  S3CasArtifactStore,
} from '../../../registry/domain/together/db/graph/freeform/registry/artifact-store.js';

describe('FsCasArtifactStore', () => {
  it('stores and retrieves bytes by sha256', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'registry-cas-'));
    try {
      const store = new FsCasArtifactStore(tmp);
      const input = new TextEncoder().encode('hello');

      const rec = await store.put({ bytes: input, media_type: 'text/plain', original_path: 'x.txt' });
      expect(rec.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(rec.size_bytes).toBe(5);
      expect(rec.media_type).toBe('text/plain');
      expect(rec.original_path).toBe('x.txt');

      const got = await store.getBySha256(rec.sha256);
      expect(got).not.toBeNull();
      expect(new TextDecoder().decode(got!.bytes)).toBe('hello');
      expect(got!.record.sha256).toBe(rec.sha256);
      expect(got!.record.size_bytes).toBe(5);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('S3CasArtifactStore', () => {
  it('stores and retrieves bytes by sha256-shaped object key', async () => {
    const fake = new FakeS3Client();
    const store = new S3CasArtifactStore({
      bucket: 'registry-artifacts',
      prefix: 'agents-registry/dev',
      client: fake,
    });

    const input = new TextEncoder().encode('hello');
    const rec = await store.put({
      bytes: input,
      media_type: 'text/plain',
      original_path: 'skills/hello.txt',
    });

    expect(rec.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(rec.size_bytes).toBe(5);
    expect(fake.lastPutKey).toBe(`agents-registry/dev/${rec.sha256.slice(0, 2)}/${rec.sha256}`);

    const got = await store.getBySha256(rec.sha256);
    expect(got).not.toBeNull();
    expect(new TextDecoder().decode(got!.bytes)).toBe('hello');
    expect(got!.record.sha256).toBe(rec.sha256);
    expect(got!.record.size_bytes).toBe(5);
    expect(got!.record.media_type).toBe('text/plain');
    expect(got!.record.original_path).toBe('skills/hello.txt');
  });
});

class FakeS3Client {
  private readonly objects = new Map<
    string,
    {
      body: Uint8Array;
      contentType?: string;
      metadata?: Record<string, string>;
    }
  >();

  lastPutKey?: string;

  async send(command: unknown) {
    const commandValue = command as { constructor: { name: string }; input: Record<string, unknown> };
    if (commandValue.constructor.name === 'PutObjectCommand') {
      const key = String(commandValue.input['Key']);
      const body = commandValue.input['Body'];
      this.lastPutKey = key;
      this.objects.set(key, {
        body: body instanceof Uint8Array ? body : new Uint8Array(),
        ...(typeof commandValue.input['ContentType'] === 'string' ? { contentType: commandValue.input['ContentType'] } : {}),
        ...(isRecord(commandValue.input['Metadata'])
          ? { metadata: commandValue.input['Metadata'] as Record<string, string> }
          : {}),
      });
      return {};
    }

    if (commandValue.constructor.name === 'GetObjectCommand') {
      const key = String(commandValue.input['Key']);
      const objectValue = this.objects.get(key);
      if (!objectValue) {
        const err = new Error('NoSuchKey');
        err.name = 'NoSuchKey';
        throw err;
      }
      return {
        Body: {
          transformToByteArray: async () => objectValue.body,
        },
        ContentLength: objectValue.body.byteLength,
        ...(objectValue.contentType ? { ContentType: objectValue.contentType } : {}),
        ...(objectValue.metadata ? { Metadata: objectValue.metadata } : {}),
      };
    }

    throw new Error(`Unexpected command: ${commandValue.constructor.name}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

