import { describe, expect, it } from 'vitest';

import { RegistryGetArtifactInputSchema } from '../../src/contracts/tools/registry-get-artifact.js';

const VALID_SHA256 = 'a'.repeat(64);

describe('registry.get_artifact input schema', () => {
  it('accepts a sha256 or a sha256 artifact urn', () => {
    expect(RegistryGetArtifactInputSchema.safeParse({ sha256: VALID_SHA256 }).success).toBe(true);
    expect(
      RegistryGetArtifactInputSchema.safeParse({ artifact_urn: `urn:sg:artifact:sha256:${VALID_SHA256}` })
        .success,
    ).toBe(true);
  });

  it('rejects malformed and traversal-shaped addresses', () => {
    const payloads = [
      { sha256: '../../../../etc/passwd' },
      { sha256: '..' },
      { sha256: VALID_SHA256.toUpperCase() },
      { sha256: VALID_SHA256.slice(0, 63) },
      { sha256: `${VALID_SHA256}0` },
      { artifact_urn: 'urn:sg:artifact:sha256:../../../../etc/passwd' },
      { artifact_urn: 'urn:sg:artifact:sha256:../..' },
      { artifact_urn: `urn:sg:artifact:sha256:${VALID_SHA256.toUpperCase()}` },
    ];
    for (const payload of payloads) {
      expect(RegistryGetArtifactInputSchema.safeParse(payload).success, JSON.stringify(payload)).toBe(false);
    }
  });

  it('still requires one of sha256 or artifact_urn', () => {
    expect(RegistryGetArtifactInputSchema.safeParse({}).success).toBe(false);
  });
});
