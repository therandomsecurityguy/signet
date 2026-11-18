/**
 * Validation report export: standardized sh:ValidationReport RDF for the
 * machine-readable reports emitted by every validation run.
 *
 * The registry's violation vocabulary was designed on the SHACL result
 * vocabulary, so the mapping is 1:1 and lossless for the standard fields:
 * - the report is a `sh:ValidationReport` with `sh:conforms`;
 * - every violation is a `sh:ValidationResult` with `sh:focusNode`,
 *   `sh:resultSeverity` (sh:Violation/Warning/Info), `sh:resultMessage`;
 * - `sh:sourceConstraintComponent` is emitted as the SHACL component IRI
 *   when the component name matches the SHACL vocabulary (it always does
 *   for the executed components); `sh:resultPath`/`sh:sourceShape` are
 *   emitted as IRIs only when the value is IRI-like — legacy JSON policy
 *   packages use bare property keys and shape ids, which are preserved as
 *   `urn:sg:property:` literals instead (plus both forms carry the literal
 *   fallback, so nothing is lost either way);
 * - per-layer metadata (layer name, `shapes_format`, `shapes_sha256`,
 *   `policy_version`, `ontology_version`, advisories, ...) is carried as
 *   `urn:sg:` literals on layer nodes hung off the report via
 *   `urn:sg:hasLayer`, with each result tied back via
 *   `urn:sg:property:layer`.
 *
 * Like the provenance export: ONE triple list feeds both the canonical
 * N-Quads (RDFC-1.0 → digest, stored as a CAS artifact) and the JSON-LD
 * document (bijection asserted by the equivalence test).
 */

import { computeCanonicalRdf } from './rdf-projection.js';
import {
  dedupeAndSortTriples,
  triplesToJsonLdGraph,
  triplesToNQuads,
  RDF_TYPE_IRI as RDF_TYPE,
  type JsonLdGraphNode,
  type RdfTriple,
  type RdfTripleObject,
} from './rdf-triples.js';
import type { ValidationViolation } from './shacl-like-validator.js';
import { assertValidIri, SG_PROPERTY_PREFIX } from './sg-vocabulary.js';

const SH = 'http://www.w3.org/ns/shacl#';

export type ValidationReportLayer = {
  layer: string;
  violations?: ValidationViolation[];
  [key: string]: unknown;
};

export type ValidationReportExportInput = {
  focus_urn: string;
  entity_type: string;
  validated_at: string;
  validator: string;
  engine?: string;
  conforms: boolean;
  layers: ValidationReportLayer[];
};

export type ValidationReportJsonLd = {
  '@context': { sh: string; sg: string };
  '@graph': JsonLdGraphNode[];
};

function isIriLike(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value);
}

/**
 * SHACL component names that map onto sh: IRIs in report exports. Custom
 * component IRIs (and anything unrecognized) are deliberately NOT coerced
 * into the sh: vocabulary — they are emitted as urn:sg: literals, plus as
 * IRIs when they are IRI-like (they already are), so consumers can resolve
 * the authored component.
 */
const KNOWN_SHACL_COMPONENT_NAMES = new Set([
  'MinCountConstraintComponent',
  'MaxCountConstraintComponent',
  'DatatypeConstraintComponent',
  'NodeKindConstraintComponent',
  'ClassConstraintComponent',
  'InConstraintComponent',
  'PatternConstraintComponent',
  'LanguageInConstraintComponent',
  'MinLengthConstraintComponent',
  'MaxLengthConstraintComponent',
  'UniqueLangConstraintComponent',
  'EqualsConstraintComponent',
  'DisjointConstraintComponent',
  'LessThanConstraintComponent',
  'LessThanOrEqualsConstraintComponent',
  'MinExclusiveConstraintComponent',
  'MinInclusiveConstraintComponent',
  'MaxExclusiveConstraintComponent',
  'MaxInclusiveConstraintComponent',
  'NodeConstraintComponent',
  'PropertyConstraintComponent',
  'QualifiedMinCountConstraintComponent',
  'QualifiedMaxCountConstraintComponent',
  'AndConstraintComponent',
  'OrConstraintComponent',
  'NotConstraintComponent',
  'XoneConstraintComponent',
  'ClosedConstraintComponent',
  'HasValueConstraintComponent',
  'SPARQLConstraintComponent',
]);

export function buildValidationReportTriples(input: ValidationReportExportInput): RdfTriple[] {
  const triples: RdfTriple[] = [];
  const reportIri = `urn:sg:validation-report:${input.focus_urn}`;
  assertValidIri(reportIri, 'validation report');
  const iri = (value: string): RdfTripleObject => ({ kind: 'iri', value });
  const literal = (value: unknown): RdfTripleObject => ({ kind: 'literal', value });
  const property = (subject: string, key: string, value: unknown): RdfTriple => ({
    subject,
    predicate: `${SG_PROPERTY_PREFIX}${key}`,
    object: literal(value),
  });

  triples.push({ subject: reportIri, predicate: RDF_TYPE, object: iri(`${SH}ValidationReport`) });
  triples.push({ subject: reportIri, predicate: `${SH}conforms`, object: literal(input.conforms) });
  triples.push(property(reportIri, 'validator', input.validator));
  triples.push(property(reportIri, 'validated_at', input.validated_at));
  triples.push(property(reportIri, 'entity_type', input.entity_type));
  if (input.engine) {
    triples.push(property(reportIri, 'engine', input.engine));
  }

  input.layers.forEach((layer, layerIndex) => {
    const layerIri = `${reportIri}#layer-${layerIndex}`;
    triples.push({ subject: reportIri, predicate: `${SG_PROPERTY_PREFIX}hasLayer`, object: iri(layerIri) });
    triples.push(property(layerIri, 'layer', layer.layer));
    for (const [key, value] of Object.entries(layer)) {
      if (key === 'violations' || key === 'layer') continue;
      if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
        triples.push(property(layerIri, key, value));
      }
      // Arrays/objects/null (scorecards, capability claims, unresolved
      // versions) stay in the JSON payload; the RDF carries scalars.
    }

    const violations = Array.isArray(layer.violations) ? layer.violations : [];
    violations.forEach((violation, resultIndex) => {
      const resultIri = `${layerIri}-result-${resultIndex}`;
      triples.push({ subject: reportIri, predicate: `${SH}result`, object: iri(resultIri) });
      triples.push({ subject: resultIri, predicate: RDF_TYPE, object: iri(`${SH}ValidationResult`) });
      triples.push(property(resultIri, 'layer', layer.layer));
      assertValidIri(violation.focusNode, 'result focus node');
      triples.push({ subject: resultIri, predicate: `${SH}focusNode`, object: iri(violation.focusNode) });
      triples.push({
        subject: resultIri,
        predicate: `${SH}resultSeverity`,
        object: iri(`${SH}${violation.severity}`),
      });
      triples.push({ subject: resultIri, predicate: `${SH}resultMessage`, object: literal(violation.message) });
      if (KNOWN_SHACL_COMPONENT_NAMES.has(violation.sourceConstraintComponent)) {
        triples.push({
          subject: resultIri,
          predicate: `${SH}sourceConstraintComponent`,
          object: iri(`${SH}${violation.sourceConstraintComponent}`),
        });
      } else {
        triples.push(property(resultIri, 'source_constraint_component', violation.sourceConstraintComponent));
        if (isIriLike(violation.sourceConstraintComponent)) {
          triples.push({
            subject: resultIri,
            predicate: `${SG_PROPERTY_PREFIX}source_constraint_component`,
            object: iri(violation.sourceConstraintComponent),
          });
        }
      }
      if (violation.resultPath) {
        triples.push(property(resultIri, 'result_path', violation.resultPath));
        if (isIriLike(violation.resultPath)) {
          triples.push({ subject: resultIri, predicate: `${SH}resultPath`, object: iri(violation.resultPath) });
        }
      }
      if (violation.sourceShape) {
        triples.push(property(resultIri, 'source_shape', violation.sourceShape));
        if (isIriLike(violation.sourceShape)) {
          triples.push({ subject: resultIri, predicate: `${SH}sourceShape`, object: iri(violation.sourceShape) });
        }
      }
    });
  });

  return dedupeAndSortTriples(triples);
}

/** Canonicalize the report export with RDFC-1.0; the digest anchors verification. */
export async function canonicalizeValidationReport(
  input: ValidationReportExportInput,
): Promise<{ nquads: string; sha256: string }> {
  return await computeCanonicalRdf(triplesToNQuads(buildValidationReportTriples(input)));
}

function compactPredicate(predicate: string): string {
  if (predicate.startsWith(SH)) return `sh:${predicate.slice(SH.length)}`;
  if (predicate.startsWith('urn:sg:')) return `sg:${predicate.slice('urn:sg:'.length)}`;
  return predicate;
}

/** JSON-LD representation derived from the same triple list as the canonical form. */
export function projectValidationReportToJsonLd(input: ValidationReportExportInput): ValidationReportJsonLd {
  return {
    '@context': { sh: SH, sg: 'urn:sg:' },
    '@graph': triplesToJsonLdGraph(buildValidationReportTriples(input), compactPredicate),
  };
}
