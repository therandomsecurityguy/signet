import { describe, expect, it } from 'vitest';

import {
  FsCasArtifactStore,
  S3CasArtifactStore,
  type ArtifactStore,
} from '../../../registry/domain/signet/db/graph/freeform/registry/artifact-store.js';

type FakeCommand = { constructor: { name: string } };

function fakeStore(responder: (name: string) => unknown) {
  return new S3CasArtifactStore({
    bucket: 'artifacts',
    client: {
      async send(command: unknown) {
        const name = (command as FakeCommand).constructor.name;
        return responder(name);
      },
    },
  });
}

const SHA = 'a'.repeat(64);

describe('S3 artifact retention reporting', () => {
  it('reports compliance-mode lock retention and legal hold', async () => {
    const store = fakeStore((name) => {
      if (name === 'GetObjectRetentionCommand') {
        return { Retention: { Mode: 'COMPLIANCE', RetainUntilDate: new Date('2030-01-01T00:00:00.000Z') } };
      }
      if (name === 'GetObjectLegalHoldCommand') {
        return { LegalHold: { Status: 'ON' } };
      }
      throw new Error(`unexpected command ${name}`);
    });
    await expect(store.getRetention(SHA)).resolves.toEqual({
      mode: 'COMPLIANCE',
      retain_until: '2030-01-01T00:00:00.000Z',
      legal_hold: true,
    });
  });

  it('reports governance mode without a hold', async () => {
    const store = fakeStore((name) => {
      if (name === 'GetObjectRetentionCommand') {
        return { Retention: { Mode: 'GOVERNANCE', RetainUntilDate: '2031-06-01T00:00:00.000Z' } };
      }
      return { LegalHold: { Status: 'OFF' } };
    });
    await expect(store.getRetention(SHA)).resolves.toEqual({
      mode: 'GOVERNANCE',
      retain_until: '2031-06-01T00:00:00.000Z',
      legal_hold: false,
    });
  });

  it('reports no retention when Object Lock is not configured', async () => {
    const store = fakeStore(() => {
      throw new Error('NoSuchObjectLockConfiguration');
    });
    await expect(store.getRetention(SHA)).resolves.toEqual({ mode: null });
  });

  it('rejects invalid digests and leaves fs stores without retention reporting', async () => {
    const store = fakeStore(() => {
      throw new Error('should not be called');
    });
    await expect(store.getRetention('not-a-digest')).resolves.toBeNull();

    const fsStore: ArtifactStore = new FsCasArtifactStore('/tmp/signet-unused-objects');
    expect(fsStore.getRetention).toBeUndefined();
  });
});
