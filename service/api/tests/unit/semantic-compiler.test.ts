import { describe, expect, it } from 'vitest';

import {
  SemanticCompileError,
  compileMarkdownSkill,
  compileToolManifest,
  mapClaimsToOntology,
  normalizeClaimTerm,
  parseFrontmatter,
} from '../../../registry/application/services/semantic-compiler.js';

const MARKDOWN = `---
name: skill:data-pipeline
display_name: Data Pipeline
description: Moves data between systems.
capabilities:
  - Data Processing
  - pii-handling
inputs: [warehouse]
outputs:
  - reports
constraints:
  - human-supervised
---

# Data Pipeline

Moves data between systems safely.

## Capabilities

- reporting

## Constraints

- no external calls
`;

describe('frontmatter parsing', () => {
  it('parses scalars, inline lists, and block lists', () => {
    const parsed = parseFrontmatter('name: demo\ninputs: [a, b]\ncapabilities:\n  - x\n  - y\n# comment\n');
    expect(parsed).toEqual({ name: 'demo', inputs: ['a', 'b'], capabilities: ['x', 'y'] });
  });

  it('fails closed on unsupported lines, malformed lists, and empty keys', () => {
    expect(() => parseFrontmatter('not a key value line')).toThrow(SemanticCompileError);
    expect(() => parseFrontmatter('key: [unterminated')).toThrow(SemanticCompileError);
    expect(() => parseFrontmatter('key:\nnext: 1')).toThrow(SemanticCompileError);
  });
});

describe('markdown compilation', () => {
  it('extracts identity, claims, interfaces, and constraints from frontmatter and body', () => {
    const compiled = compileMarkdownSkill(MARKDOWN);
    expect(compiled.skill_key).toBe('skill:data-pipeline');
    expect(compiled.display_name).toBe('Data Pipeline');
    expect(compiled.description).toBe('Moves data between systems.');
    expect(compiled.capability_claims).toEqual(['data-processing', 'pii-handling', 'reporting']);
    expect(compiled.interfaces).toEqual({ inputs: ['warehouse'], outputs: ['reports'] });
    expect(compiled.constraints).toEqual(['human-supervised', 'no external calls']);
    expect(compiled.warnings.some((w) => w.includes('Data Processing'))).toBe(true);
  });

  it('falls back to body extraction without frontmatter', () => {
    const compiled = compileMarkdownSkill('# Demo\n\nA demo skill.\n\n## Capabilities\n\n- analytics\n');
    expect(compiled.display_name).toBe('Demo');
    expect(compiled.description).toBe('A demo skill.');
    expect(compiled.capability_claims).toEqual(['analytics']);
  });

  it('warns when no claims are extractable', () => {
    const compiled = compileMarkdownSkill('# Empty\n\nNothing here.\n');
    expect(compiled.capability_claims).toEqual([]);
    expect(compiled.warnings).toContain('no capability claims extracted from markdown source');
  });
});

describe('tool manifest compilation', () => {
  it('extracts claims from capabilities and tool names', () => {
    const compiled = compileToolManifest(
      JSON.stringify({
        name: 'skill:manifest',
        description: 'manifest skill',
        capabilities: ['Data Processing'],
        tools: [{ name: 'Report Generator' }],
        inputs: ['warehouse'],
        outputs: ['reports'],
        constraints: ['human-supervised'],
      }),
    );
    expect(compiled.skill_key).toBe('skill:manifest');
    expect(compiled.capability_claims).toEqual(['data-processing', 'report-generator']);
    expect(compiled.interfaces).toEqual({ inputs: ['warehouse'], outputs: ['reports'] });
    expect(compiled.constraints).toEqual(['human-supervised']);
  });

  it('rejects invalid JSON and non-object manifests', () => {
    expect(() => compileToolManifest('not json')).toThrow(SemanticCompileError);
    expect(() => compileToolManifest('[1,2]')).toThrow(SemanticCompileError);
  });
});

describe('claim normalization and ontology mapping', () => {
  it('normalizes terms toward concept-id style', () => {
    expect(normalizeClaimTerm('  Data Processing ')).toBe('data-processing');
    expect(normalizeClaimTerm('PII_Handling!')).toBe('pii-handling');
  });

  it('maps claims against known concepts', () => {
    const result = mapClaimsToOntology(['data-processing', 'teleportation'], {
      kind: 'skill_area',
      concepts: [{ id: 'data-processing' }],
      disjoint: [],
    });
    expect(result).toEqual({ mapped: ['data-processing'], unmapped: ['teleportation'] });
  });
});
