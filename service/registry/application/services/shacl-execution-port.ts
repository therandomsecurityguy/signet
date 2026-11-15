/**
 * Engine-agnostic port for W3C SHACL execution.
 *
 * The registry validates publication graphs against SHACL shapes (built-in
 * graph shape + registered policy packages). Execution is delegated to a
 * concrete engine behind this port so the engine (currently
 * rdf-validate-shacl, in-process) can be swapped — for example to a sidecar
 * if SHACL-SPARQL support is ever required — without touching validation
 * orchestration.
 *
 * Boundary contract: the port receives N-Quads (data) and Turtle (shapes),
 * and returns SHACL result terms normalized to plain strings. Pattern
 * constraints never reach the engine: `sh:pattern` is stripped during shape
 * translation and executed by the registry's RE2-owned pattern layer
 * (backtracking JS RegExp engines are ReDoS-unsafe by construction).
 */

export type ShaclValidationResult = {
  focusNode: string;
  path?: string;
  sourceConstraintComponent: string;
  sourceShape?: string;
  message?: string;
  severity: string;
  /** Lexical form of the offending value node, when the engine reports one. */
  value?: string;
};

export type ShaclValidationReport = {
  conforms: boolean;
  results: ShaclValidationResult[];
};

export interface ShaclExecutionPort {
  /** Engine identifier recorded in validation report artifacts. */
  readonly engine: string;
  validate(input: { data_nquads: string; shapes_turtle: string }): Promise<ShaclValidationReport>;
}
