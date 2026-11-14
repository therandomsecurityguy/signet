import { createHash } from 'node:crypto';

export function parseArtifactSha256(artifactUrn: string): string | undefined {
  const prefix = 'urn:tg:artifact:sha256:';
  return artifactUrn.startsWith(prefix) ? artifactUrn.slice(prefix.length) : undefined;
}

export function parseHarnessName(harnessUrnValue: string): string | undefined {
  const prefix = 'urn:tg:harness:';
  return harnessUrnValue.startsWith(prefix) ? harnessUrnValue.slice(prefix.length) : undefined;
}

export function parseSkillKey(skillUrnValue: string): string | undefined {
  const prefix = 'urn:tg:skill:';
  return skillUrnValue.startsWith(prefix) ? skillUrnValue.slice(prefix.length) : undefined;
}

export function decodeArtifactInput(content: string, encoding: 'utf8' | 'base64'): Uint8Array {
  return encoding === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8');
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
