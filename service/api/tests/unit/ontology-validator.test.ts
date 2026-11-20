import { describe, expect, it } from 'vitest';

import {
  OntologyDocumentError,
  parseOntologyDocument,
  validateCapabilityClaims,
  type OntologyDocument,
} from '../../../registry/application/services/ontology-validator.js';

const SKILL_AREA: OntologyDocument = {
  kind: 'skill_area',
  concepts: [
    { id: 'data-processing' },
    { id: 'pii-handling', parents: ['data-processing'] },
    { id: 'public-data', parents: ['data-processing'] },
  ],
  disjoint: [['pii-handling', 'public-data']],
};

describe('ontology document parsing', () => {
  it('parses a valid document', () => {
    const parsed = parseOntologyDocument({
      kind: 'skill_area',
      concepts: [{ id: 'a' }, { id: 'b', label: 'B', parents: ['a'] }],
      disjoint: [['a', 'b']],
    });
    expect(parsed.kind).toBe('skill_area');
    expect(parsed.concepts).toHaveLength(2);
    expect(parsed.disjoint).toEqual([['a', 'b']]);
  });

  it('rejects malformed documents', () => {
    expect(() => parseOntologyDocument(null)).toThrow(OntologyDocumentError);
    expect(() => parseOntologyDocument({ kind: 'other', concepts: [{ id: 'a' }] })).toThrow(OntologyDocumentError);
    expect(() => parseOntologyDocument({ kind: 'skill_area', concepts: [] })).toThrow(OntologyDocumentError);
    expect(() => parseOntologyDocument({ kind: 'skill_area', concepts: [{ label: 'no id' }] })).toThrow(
      OntologyDocumentError,
    );
    expect(() => parseOntologyDocument({ kind: 'skill_area', concepts: [{ id: 'a' }, { id: 'a' }] })).toThrow(
      /Duplicate concept id/,
    );
    expect(() =>
      parseOntologyDocument({ kind: 'skill_area', concepts: [{ id: 'a', parents: ['missing'] }] }),
    ).toThrow(/unknown parent/);
    expect(() =>
      parseOntologyDocument({ kind: 'skill_area', concepts: [{ id: 'a' }], disjoint: [['a', 'missing']] }),
    ).toThrow(/unknown concept/);
    expect(() =>
      parseOntologyDocument({ kind: 'skill_area', concepts: [{ id: 'a' }], disjoint: [['a']] }),
    ).toThrow(OntologyDocumentError);
  });
});

describe('capability claim validation', () => {
  it('passes claims that bind to known concepts', () => {
    const result = validateCapabilityClaims({
      focus_urn: 'urn:sg:skill-version:skill:demo@v1',
      claims: ['data-processing', 'pii-handling'],
      document: SKILL_AREA,
      ontology_version: 'skill-area/v1',
    });
    expect(result.violations).toEqual([]);
    expect(result.de_facto_candidates).toEqual([]);
  });

  it('fails unmapped claims and records them as de facto candidates', () => {
    const result = validateCapabilityClaims({
      focus_urn: 'urn:sg:skill-version:skill:demo@v1',
      claims: ['data-processing', 'teleportation'],
      document: SKILL_AREA,
      ontology_version: 'skill-area/v1',
    });
    expect(result.de_facto_candidates).toEqual(['teleportation']);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      focusNode: 'urn:sg:skill-version:skill:demo@v1',
      resultPath: 'capability_claims',
      sourceConstraintComponent: 'OntologyBindingConstraintComponent',
      sourceShape: 'ontology:skill-area/v1',
      severity: 'Violation',
    });
  });

  it('fails disjoint claim combinations even when every claim binds', () => {
    const result = validateCapabilityClaims({
      focus_urn: 'urn:sg:skill-version:skill:demo@v1',
      claims: ['pii-handling', 'public-data'],
      document: SKILL_AREA,
      ontology_version: 'skill-area/v1',
    });
    expect(result.de_facto_candidates).toEqual([]);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      sourceConstraintComponent: 'OntologyDisjointConstraintComponent',
      severity: 'Violation',
    });
    expect(result.violations[0]?.message).toContain('pii-handling + public-data');
  });

  it('propagates disjointness through the subclass hierarchy', () => {
    const HIERARCHY: OntologyDocument = {
      kind: 'skill_area',
      concepts: [
        { id: 'analysis' },
        { id: 'reporting-base' },
        { id: 'transform', parents: ['analysis'] },
        { id: 'transform-v2', parents: ['transform'] },
        { id: 'report', parents: ['reporting-base'] },
        { id: 'bridging', parents: ['analysis', 'reporting-base'] },
      ],
      disjoint: [['analysis', 'reporting-base']],
    };
    const validate = (claims: string[]) =>
      validateCapabilityClaims({
        focus_urn: 'urn:sg:skill-version:skill:demo@v1',
        claims,
        document: HIERARCHY,
        ontology_version: 'hierarchy/v1',
      });

    // Subclass + subclass: conflict with the disjoint ancestor pair as evidence.
    const both = validate(['transform', 'report']);
    expect(both.violations).toHaveLength(1);
    expect(both.violations[0]?.message).toBe(
      'capability claims combine disjoint concepts: transform + report (via analysis + reporting-base)',
    );

    // Deep descendant + exact ancestor on the other side.
    const mixed = validate(['reporting-base', 'transform-v2']);
    expect(mixed.violations).toHaveLength(1);
    expect(mixed.violations[0]?.message).toBe(
      'capability claims combine disjoint concepts: transform-v2 + reporting-base (via analysis + reporting-base)',
    );

    // Subclasses of the SAME parent never conflict across that pair.
    expect(validate(['transform', 'transform-v2']).violations).toEqual([]);

    // A single multiply-derived claim covering both sides is an ontology
    // inconsistency question, not a claim combination.
    expect(validate(['bridging']).violations).toEqual([]);
    expect(validate(['bridging', 'transform']).violations).toEqual([]);
  });
});
