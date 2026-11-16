/**
 * rdf-validate-shacl execution adapter.
 *
 * In-process W3C SHACL Core execution (Zazuko rdf-validate-shacl) over
 * N-Quads data and Turtle shapes. Chosen over shacl-engine in the scoping
 * spike: identical results with simpler term mapping (component names
 * already match the registry's violation vocabulary) and a much smaller
 * dependency tree. Validation graphs are single-publication sized (tens of
 * quads; ~100ms at 12k quads), so in-process execution is not a bottleneck.
 */

import { Parser, Store } from 'n3';
import SHACLValidator from 'rdf-validate-shacl';

import type { ShaclExecutionPort, ShaclValidationReport } from './shacl-execution-port.js';

/**
 * Recorded in validation report artifacts. A unit test asserts this
 * constant matches the pinned dependency in package.json so reports can
 * never claim a stale engine version.
 */
export const RDF_VALIDATE_SHACL_ENGINE_ID = 'rdf-validate-shacl@0.6.5';

const SHACL_NS = 'http://www.w3.org/ns/shacl#';

export class RdfValidateShaclEngine implements ShaclExecutionPort {
  readonly engine = RDF_VALIDATE_SHACL_ENGINE_ID;

  async validate(input: { data_nquads: string; shapes_turtle: string }): Promise<ShaclValidationReport> {
    const shapes = new Store(new Parser({ format: 'text/turtle' }).parse(input.shapes_turtle));
    const data = new Store(new Parser({ format: 'application/n-quads' }).parse(input.data_nquads));
    const report = await new SHACLValidator(shapes).validate(data);
    return {
      conforms: report.conforms,
      results: (report.results ?? []).map((result) => ({
        focusNode: result.focusNode.value,
        ...(result.path ? { path: result.path.value } : {}),
        sourceConstraintComponent: result.sourceConstraintComponent.value.replace(SHACL_NS, ''),
        ...(result.sourceShape ? { sourceShape: result.sourceShape.value } : {}),
        ...(result.message?.[0] ? { message: result.message[0].value } : {}),
        severity: result.severity.value.replace(SHACL_NS, ''),
        ...(result.value ? { value: result.value.value } : {}),
      })),
    };
  }
}

export function createRdfValidateShaclEngine(): ShaclExecutionPort {
  return new RdfValidateShaclEngine();
}
