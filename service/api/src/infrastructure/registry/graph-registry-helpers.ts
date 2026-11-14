import { createHash } from 'node:crypto';

const ARTIFACT_SHA256_PATTERN = /^[0-9a-f]{64}$/;

export function parseArtifactSha256(artifactUrn: string): string | undefined {
  const prefix = 'urn:sg:artifact:sha256:';
  if (!artifactUrn.startsWith(prefix)) return undefined;
  const sha256 = artifactUrn.slice(prefix.length);
  return ARTIFACT_SHA256_PATTERN.test(sha256) ? sha256 : undefined;
}

export function parseHarnessName(harnessUrnValue: string): string | undefined {
  const prefix = 'urn:sg:harness:';
  return harnessUrnValue.startsWith(prefix) ? harnessUrnValue.slice(prefix.length) : undefined;
}

export function parseSkillKey(skillUrnValue: string): string | undefined {
  const prefix = 'urn:sg:skill:';
  return skillUrnValue.startsWith(prefix) ? skillUrnValue.slice(prefix.length) : undefined;
}

export function decodeArtifactInput(content: string, encoding: 'utf8' | 'base64'): Uint8Array {
  return encoding === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8');
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
