import { describe, expect, it } from 'vitest';

import {
  artifactFileName,
  mediaTypeExtension,
  sanitizeTargetSegment,
  sourceFileBaseName,
  targetDirectory,
} from '../src/pull.js';

describe('pull helpers', () => {
  it('maps media types to file extensions', () => {
    expect(mediaTypeExtension('text/markdown')).toBe('.md');
    expect(mediaTypeExtension('application/json')).toBe('.json');
    expect(mediaTypeExtension('application/n-quads')).toBe('.nq');
    expect(mediaTypeExtension(undefined)).toBe('.bin');
    expect(mediaTypeExtension('application/x-custom')).toBe('.bin');
  });

  it('names single and multiple artifacts deterministically', () => {
    expect(artifactFileName({ mediaType: 'text/markdown', sha256: 'a'.repeat(64), multiple: false })).toBe(
      'content.md',
    );
    expect(artifactFileName({ mediaType: 'text/markdown', sha256: 'ab'.repeat(32), multiple: true })).toBe(
      'content-abababab.md',
    );
    expect(artifactFileName({ sha256: 'b'.repeat(64), multiple: false })).toBe('content.bin');
  });

  it('sanitizes target segments for portable directory names', () => {
    expect(sanitizeTargetSegment('skill:registry-mcp')).toBe('skill_registry-mcp');
    expect(sanitizeTargetSegment('agent:cursor:helper')).toBe('agent_cursor_helper');
    expect(sanitizeTargetSegment('..')).toBe('_');
    expect(sanitizeTargetSegment('ok.name@v1')).toBe('ok.name@v1');
  });

  it('builds the pull directory layout', () => {
    expect(targetDirectory('/tmp/out', 'skill', 'skill:foo', 3)).toBe('/tmp/out/skills/skill_foo/v3');
    expect(targetDirectory('/tmp/out', 'agent', 'cursor:helper', 1)).toBe('/tmp/out/agents/cursor_helper/v1');
  });

  it('derives artifact base names from source paths', () => {
    expect(sourceFileBaseName('skills/registry-search.md')).toBe('registry-search.md');
    expect(sourceFileBaseName('agents/cursor helper.md')).toBe('cursor_helper.md');
    expect(sourceFileBaseName(undefined)).toBeUndefined();
    expect(sourceFileBaseName('skills/')).toBeUndefined();
    expect(sourceFileBaseName('skills///')).toBeUndefined();
  });
});
