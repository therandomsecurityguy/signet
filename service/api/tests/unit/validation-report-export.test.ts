import { describe, expect, it } from 'vitest';

import {
  buildValidationReportTriples,
  canonicalizeValidationReport,
  projectValidationReportToJsonLd,
  type ValidationReportExportInput,
} from '../../../registry/application/services/validation-report-export.js';
import type { ValidationViolation } from '../../../registry/application/services/shacl-like-validator.js';

const SH = 'http://www.w3.org/ns/shacl#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

function violation(overrides: Partial<ValidationViolation> = {}): ValidationViolation {
  return {
    focusNode: 'urn:sg:skill-version:skill:demo@v1',
    resultPath: 'artifact_sha256',
    sourceConstraintComponent: 'MinCountConstraintComponent',
    sourceShape: 'shape/counts',
    message: 'missing_artifact_evidence',
    severity: 'Violation',
    ...overrides,
  };
}

function report(overrides: Partial<ValidationReportExportInput> = {}): ValidationReportExportInput {
  return {
    focus_urn: 'urn:sg:skill-version:skill:demo@v1',
    entity_type: 'SKILL_VERSION',
    validated_at: '2026-11-16T21:00:00.000Z',
    validator: 'shacl-v1',
    engine: 'rdf-validate-shacl@0.6.5',
    conforms: false,
    layers: [
      {
        layer: 'graph_shape',
        shape_document: 'registry-graph-shape/builtin',
        shapes_format: 'shacl-turtle',
        shapes_sha256: 'a'.repeat(64),
        violations: [violation()],
      },
      {
        layer: 'policy',
        policy_version: 'demo-shacl/v1',
        shapes_format: 'shacl-turtle',
        shapes_sha256: 'b'.repeat(64),
        violations: [
          violation({
            resultPath: 'urn:sg:property:description',
            sourceConstraintComponent: 'InConstraintComponent',
            sourceShape: 'urn:policy:description',
            message: 'not one of the allowed values',
            severity: 'Warning',
          }),
        ],
        capability_claims: ['summarize-text'],
        de_facto_candidates: [],
      },
    ],
    ...overrides,
  };
}

function invertJsonLd(jsonld: ReturnType<typeof projectValidationReportToJsonLd>): string[] {
  const triples: Array<[string, string, 'iri' | 'literal', unknown]> = [];
  const expand = (predicate: string): string =>
    predicate.startsWith('sh:') ? `${SH}${predicate.slice('sh:'.length)}` : predicate.startsWith('sg:')
      ? `urn:sg:${predicate.slice('sg:'.length)}`
      : predicate;
  for (const node of jsonld['@graph']) {
    const subject = node['@id'];
    for (const type of node['@type'] ?? []) {
      triples.push([subject, RDF_TYPE, 'iri', type]);
    }
    for (const [predicate, entries] of Object.entries(node)) {
      if (predicate === '@id' || predicate === '@type') continue;
      for (const entry of entries as Array<Record<string, unknown>>) {
        if (typeof entry['@id'] === 'string') {
          triples.push([subject, expand(predicate), 'iri', entry['@id']]);
        } else if (entry['@value'] !== undefined) {
          triples.push([subject, expand(predicate), 'literal', entry['@value']]);
        }
      }
    }
  }
  return triples.map((triple) => JSON.stringify(triple)).sort();
}

function sortedTripleKeys(input: ValidationReportExportInput): string[] {
  return buildValidationReportTriples(input)
    .map((triple) => JSON.stringify([triple.subject, triple.predicate, triple.object.kind, triple.object.value]))
    .sort();
}

describe('validation report export', () => {
  it('produces a byte-stable canonical digest across runs', async () => {
    const first = await canonicalizeValidationReport(report());
    const second = await canonicalizeValidationReport(report());
    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(second.sha256).toBe(first.sha256);
    expect(second.nquads).toBe(first.nquads);
  });

  it('JSON-LD is a lossless representation of the same triple list', () => {
    const jsonld = projectValidationReportToJsonLd(report());
    expect(jsonld['@context']).toEqual({ sh: SH, sg: 'urn:sg:' });
    expect(invertJsonLd(jsonld)).toEqual(sortedTripleKeys(report()));
  });

  it('maps violations onto the SHACL result vocabulary with literal fallbacks', async () => {
    const { nquads } = await canonicalizeValidationReport(report());
    const reportIri = 'urn:sg:validation-report:urn:sg:skill-version:skill:demo@v1';

    // Report-level: conforms as xsd:boolean, engine + validator fingerprints.
    expect(nquads).toContain(`<${reportIri}> <${SH}conforms> "false"^^<http://www.w3.org/2001/XMLSchema#boolean> .`);
    expect(nquads).toContain(`<${reportIri}> <urn:sg:property:engine> "rdf-validate-shacl@0.6.5" .`);
    expect(nquads).toContain(`<${reportIri}> <${RDF_TYPE}> <${SH}ValidationReport> .`);

    // Component names map onto SHACL component IRIs.
    expect(nquads).toContain(`<${SH}MinCountConstraintComponent>`);
    expect(nquads).toContain(`<${SH}InConstraintComponent>`);

    // Severities map onto sh:Violation/Warning IRIs.
    expect(nquads).toContain(`<${SH}resultSeverity> <${SH}Violation> .`);
    expect(nquads).toContain(`<${SH}resultSeverity> <${SH}Warning> .`);

    // Legacy bare paths/shape ids stay as urn:sg: literals without
    // sh:resultPath/sh:sourceShape IRIs (they are not IRIs).
    expect(nquads).toContain('<urn:sg:property:result_path> "artifact_sha256" .');
    expect(nquads).not.toContain(`<${SH}resultPath> "artifact_sha256"`);
    expect(nquads).toContain('<urn:sg:property:source_shape> "shape/counts" .');
    expect(nquads).not.toContain(`<${SH}sourceShape> "shape/counts"`);

    // IRI-like paths get the standard sh:resultPath plus the literal.
    expect(nquads).toContain(`<${SH}resultPath> <urn:sg:property:description> .`);
    expect(nquads).toContain('<urn:sg:property:result_path> "urn:sg:property:description" .');
    expect(nquads).toContain(`<${SH}sourceShape> <urn:policy:description> .`);

    // Layer metadata: scalars carried, arrays stay JSON-only.
    expect(nquads).toContain(`<${reportIri}#layer-1> <urn:sg:property:policy_version> "demo-shacl/v1" .`);
    expect(nquads).toContain(`<${reportIri}#layer-1> <urn:sg:property:shapes_sha256> "${'b'.repeat(64)}" .`);
    expect(nquads).not.toContain('capability_claims');
  });

  it('encodes a conforming report with no results', async () => {
    const { nquads } = await canonicalizeValidationReport(
      report({ conforms: true, layers: [{ layer: 'graph_shape', violations: [] }] }),
    );
    expect(nquads).toContain(`<${SH}conforms> "true"^^<http://www.w3.org/2001/XMLSchema#boolean> .`);
    expect(nquads).not.toContain(`<${SH}result>`);
  });
});
