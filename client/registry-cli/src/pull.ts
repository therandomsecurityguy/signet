import * as path from 'node:path';

// registry-operator pull (build plan 3.2): materialize verified bytes plus an
// integrity manifest in one command. The helpers here are pure so the
// layout and manifest shape are unit-testable without a registry.

export type PullManifestArtifact = {
  sha256: string;
  file: string;
  media_type?: string;
};

export type PullManifest = {
  manifest_version: 1;
  type: 'skill' | 'agent';
  key: string;
  version: number;
  publication_urn: string;
  envelope_sha256: string;
  strict: boolean;
  server_verification_status: string;
  valid_signatures: number;
  /** Server-reported frozen-envelope facts, preserved as evidence. */
  frozen_envelope_artifact_present: boolean;
  live_envelope_matches_frozen_artifact: boolean | null;
  artifacts: PullManifestArtifact[];
  pulled_at: string;
};

export function mediaTypeExtension(mediaType: string | undefined): string {
  switch (mediaType) {
    case 'text/markdown':
      return '.md';
    case 'text/plain':
      return '.txt';
    case 'application/json':
      return '.json';
    case 'application/n-quads':
      return '.nq';
    case 'text/turtle':
      return '.ttl';
    default:
      return '.bin';
  }
}

export function artifactFileName(input: { mediaType?: string; sha256: string; multiple: boolean }): string {
  const extension = mediaTypeExtension(input.mediaType);
  return input.multiple ? `content-${input.sha256.slice(0, 8)}${extension}` : `content${extension}`;
}

// Keys are URN-ish (`skill:foo`, `agent:cursor:bar`); directory names must
// not depend on ':' (Windows) or path separators.
export function sanitizeTargetSegment(segment: string): string {
  const cleaned = segment.replaceAll(/[^A-Za-z0-9._@-]+/g, '_');
  return cleaned.length > 0 && cleaned !== '.' && cleaned !== '..' ? cleaned : '_';
}

export function targetDirectory(outDir: string, type: 'skill' | 'agent', key: string, version: number): string {
  return path.join(outDir, `${type}s`, sanitizeTargetSegment(key), `v${version}`);
}

// Preferred artifact file name: the source file's basename (e.g.
// `registry-search.md`). Falls back to `content.<ext>` when the version
// carries no usable source path; callers add a digest prefix on collisions.
export function sourceFileBaseName(sourcePath: string | undefined): string | undefined {
  if (!sourcePath) return undefined;
  const base = sourcePath.split('/').pop() ?? '';
  if (base.length === 0) return undefined;
  const cleaned = sanitizeTargetSegment(base);
  return /[A-Za-z0-9]/.test(cleaned) ? cleaned : undefined;
}
