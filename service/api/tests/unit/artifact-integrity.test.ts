import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { buildRegistryCore } from '../../../registry/application/build-registry-core.js';
import {
  CasIntegrityError,
  FsCasArtifactStore,
} from '../../../registry/domain/signet/db/graph/freeform/registry/artifact-store.js';

const tempDirs: string[] = [];

async function makeTempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'signet-cas-integrity-'));
  tempDirs.push(dir);
  return dir;
}

function objectPath(root: string, sha256: string) {
  return path.join(root, sha256.slice(0, 2), sha256);
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('CAS digest verification on read', () => {
  it('verifies intact objects and surfaces tampered bytes in warn mode', async () => {
    const dir = await makeTempDir();
    const store = new FsCasArtifactStore(dir);
    const record = await store.put({
      bytes: Buffer.from('integrity-checked payload', 'utf8'),
      media_type: 'text/plain',
    });

    const intact = await store.getBySha256(record.sha256);
    expect(intact?.digest_verified).toBe(true);
    expect(intact?.computed_sha256).toBe(record.sha256);

    await writeFile(objectPath(dir, record.sha256), 'tampered payload');
    const tampered = await store.getBySha256(record.sha256);
    expect(tampered).not.toBeNull();
    expect(tampered?.digest_verified).toBe(false);
    expect(tampered?.computed_sha256).not.toBe(record.sha256);

    const missing = await store.getBySha256('f'.repeat(64));
    expect(missing).toBeNull();
  });

  it('fails closed in enforce mode', async () => {
    const dir = await makeTempDir();
    const store = new FsCasArtifactStore(dir, { integrity_mode: 'enforce' });
    const record = await store.put({ bytes: Buffer.from('strict payload', 'utf8') });

    await writeFile(objectPath(dir, record.sha256), 'tampered payload');
    await expect(store.getBySha256(record.sha256)).rejects.toBeInstanceOf(CasIntegrityError);
  });

  it('propagates integrity failures through the registry core as ARTIFACT_DIGEST_MISMATCH', async () => {
    const dir = await makeTempDir();

    const core = buildRegistryCore({
      graph_backend: 'memory',
      artifact_backend: 'fs',
      objects_dir: dir,
    });
    const record = await core.cas.put({
      bytes: Buffer.from('publication artifact', 'utf8'),
      media_type: 'text/markdown',
    });

    const intact = await core.service.getArtifact({ sha256: record.sha256 });
    expect(intact?.digest_verified).toBe(true);
    expect(intact?.content).toBe('publication artifact');

    await writeFile(objectPath(dir, record.sha256), 'tampered publication artifact');
    const tampered = await core.service.getArtifact({ sha256: record.sha256 });
    expect(tampered?.digest_verified).toBe(false);

    const strictCore = buildRegistryCore({
      graph_backend: 'memory',
      artifact_backend: 'fs',
      objects_dir: dir,
      artifact_integrity_mode: 'enforce',
    });
    await expect(strictCore.service.getArtifact({ sha256: record.sha256 })).rejects.toMatchObject({
      code: 'ARTIFACT_DIGEST_MISMATCH',
    });
  });
});

describe('CAS content-address validation', () => {
  it('rejects non-sha256 keys before they can reach the filesystem', async () => {
    const dir = await makeTempDir();
    const store = new FsCasArtifactStore(dir);
    const record = await store.put({ bytes: Buffer.from('target payload', 'utf8') });

    const payloads = [
      '../../../../etc/passwd',
      '..',
      '../'.repeat(4) + 'etc/passwd',
      record.sha256.toUpperCase(),
      record.sha256.slice(0, 63),
      `${record.sha256}0`,
      `urn:sg:artifact:sha256:${record.sha256}`,
    ];
    for (const payload of payloads) {
      expect(await store.getBySha256(payload), payload).toBeNull();
    }

    // The intact object is still reachable, so the validation is not blanket.
    expect((await store.getBySha256(record.sha256))?.digest_verified).toBe(true);
  });

  it('rejects traversal payloads through the registry core getArtifact paths', async () => {
    const dir = await makeTempDir();
    const core = buildRegistryCore({
      graph_backend: 'memory',
      artifact_backend: 'fs',
      objects_dir: dir,
    });

    expect(await core.service.getArtifact({ sha256: '../../../../etc/passwd' })).toBeNull();
    expect(
      await core.service.getArtifact({ artifact_urn: 'urn:sg:artifact:sha256:../../../../etc/passwd' }),
    ).toBeNull();
    expect(await core.service.getArtifactBytes({ sha256: '../'.repeat(4) + 'etc/passwd' })).toBeNull();
  });
});
