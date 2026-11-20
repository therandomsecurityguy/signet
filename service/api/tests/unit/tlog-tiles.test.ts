import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import { closeSidecarServers, startNativeSidecar } from './support/native-sidecar.js';

// Shared oracle with the Go runtime tests: the same fixture is verified
// against the real transparency-dev layout + serialization packages in
// service/tessera-runtime/tile_fixture_test.go.
const FIXTURE = JSON.parse(
  readFileSync(new URL('../../../tessera-runtime/testdata/tiles/spec-tiles-v1.json', import.meta.url), 'utf8'),
) as {
  tree_size: number;
  root_hash_hex: string;
  payloads: string[];
  leaf_hashes_hex: string[];
  tiles: Record<string, string>;
  entries: Record<string, string>;
};

const BUCKET = 'transparency-test-bucket';
const TILES_PREFIX = 'tessera/tiles/test';
const REQUESTS_PREFIX = 'tessera/requests/test';
const LOG_ID = 'signet-test-log';

afterEach(async () => {
  await closeSidecarServers();
});

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Seed the fixture leaf set directly into the sidecar's fake S3 store. */
function seedFixtureLog(objects: Map<string, Buffer>) {
  for (let index = 0; index < FIXTURE.tree_size; index += 1) {
    const payload = FIXTURE.payloads[index] as string;
    const recordKey = `${REQUESTS_PREFIX}/${LOG_ID}/${index}.json`;
    objects.set(`${BUCKET}/${TILES_PREFIX}/${LOG_ID}/leaves/${String(index).padStart(10, '0')}.json`, Buffer.from(
      JSON.stringify({
        entry_index: index,
        request_id: `req-${index}`,
        record_key: recordKey,
        record_sha256: sha256Hex(payload),
        leaf_hash: FIXTURE.leaf_hashes_hex[index],
        created_at: '2026-01-01T00:00:00.000Z',
      }),
      'utf8',
    ));
    objects.set(`${BUCKET}/${recordKey}`, Buffer.from(payload, 'utf8'));
  }
  objects.set(
    `${BUCKET}/${TILES_PREFIX}/${LOG_ID}/state.json`,
    Buffer.from(
      JSON.stringify({
        tree_size: FIXTURE.tree_size,
        root_hash: FIXTURE.root_hash_hex,
        updated_at: '2026-01-01T00:00:00.000Z',
      }),
      'utf8',
    ),
  );
}

describe('tlog-tiles read API', () => {
  it('serves byte-identical hash tiles, entry bundles, and a coherent checkpoint', async () => {
    const sidecar = await startNativeSidecar();
    seedFixtureLog(sidecar.objects);

    for (const [path, expectedB64] of Object.entries(FIXTURE.tiles)) {
      const response = await fetch(`${sidecar.baseUrl}/tiles/${LOG_ID}/${path}`);
      expect(response.status, path).toBe(200);
      expect(response.headers.get('content-type')).toBe('application/octet-stream');
      const body = Buffer.from(await response.arrayBuffer());
      expect(body.equals(Buffer.from(expectedB64, 'base64')), path).toBe(true);
    }

    for (const [path, expectedB64] of Object.entries(FIXTURE.entries)) {
      const response = await fetch(`${sidecar.baseUrl}/tiles/${LOG_ID}/${path}`);
      expect(response.status, path).toBe(200);
      const body = Buffer.from(await response.arrayBuffer());
      expect(body.equals(Buffer.from(expectedB64, 'base64')), path).toBe(true);
    }

    const checkpoint = await fetch(`${sidecar.baseUrl}/tiles/${LOG_ID}/checkpoint`);
    expect(checkpoint.status).toBe(200);
    const checkpointText = await checkpoint.text();
    const rootB64 = Buffer.from(FIXTURE.root_hash_hex, 'hex').toString('base64');
    expect(checkpointText.startsWith(`${LOG_ID}\n${FIXTURE.tree_size}\n${rootB64}\n`)).toBe(true);
    expect(checkpointText).toContain('\u2014 ');
  });

  it('returns 404 for missing, stale, or non-canonical tiles', async () => {
    const sidecar = await startNativeSidecar();
    seedFixtureLog(sidecar.objects);

    const notFound = [
      `/tiles/${LOG_ID}/tile/0/002`, // no such full tile
      `/tiles/${LOG_ID}/tile/0/001.p/43`, // stale partial width
      `/tiles/${LOG_ID}/tile/1/000.p/2`, // stale level-1 partial
      `/tiles/${LOG_ID}/tile/1/001`, // beyond the tree
      `/tiles/${LOG_ID}/tile/entries/002`, // no such full bundle
      `/tiles/${LOG_ID}/tile/entries/001.p/43`, // stale partial
      `/tiles/${LOG_ID}/tile/0/x01/000`, // non-canonical grouping
      `/tiles/${LOG_ID}/tile/0/01`, // non-canonical tail width
      `/tiles/unknown-log/checkpoint`, // unknown log
    ];
    for (const path of notFound) {
      const response = await fetch(`${sidecar.baseUrl}${path}`);
      expect(response.status, path).toBe(404);
    }
  });
});
