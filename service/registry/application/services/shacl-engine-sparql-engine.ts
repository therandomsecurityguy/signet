/**
 * shacl-engine execution adapter (SPARQL-capable hybrid).
 *
 * The registry's default engine (rdf-validate-shacl) covers W3C SHACL Core.
 * Authored policies that use SPARQL features need more: this adapter runs
 * shacl-engine with its SPARQL plugin — validations AND target resolvers
 * are ALWAYS loaded, because without the plugin shacl-engine silently
 * ignores `sh:sparql` constraints (violating data would read as
 * conforming; guarded by a test asserting a violating fixture never
 * conforms).
 *
 * The engine is imported lazily (first SPARQL-feature shapes document) so
 * the Comunica-based plugin chain stays off the default hot path. Results
 * are normalized into the same port shape as the rdf-validate-shacl
 * adapter; SPARQL constraint results report
 * `SPARQLConstraintComponent` and carry the row's `?path`/`?value` plus
 * `{...}`-interpolated messages.
 *
 * Property-shape `sh:sparql` is deliberately rejected at registration: this
 * engine evaluates property-shape constraints once against the focus node
 * with a non-standard `$PATH` placeholder instead of the W3C prebinding
 * model, so spec-authored shapes would silently misbehave.
 */

import { DataFactory, Parser, Store } from 'n3';

import type { ShaclExecutionPort, ShaclValidationReport } from './shacl-execution-port.js';

const SHACL_NS = 'http://www.w3.org/ns/shacl#';

/** Recorded in validation report artifacts. A test pins this to package.json. */
export const SHACL_ENGINE_SPARQL_ENGINE_ID = 'shacl-engine@1.1.3+sparql';

let cachedAdapter: Promise<ShaclExecutionPort> | undefined;

function extractPathIri(rawPath: unknown): string | undefined {
  if (!Array.isArray(rawPath)) return undefined;
  const descriptor = rawPath[rawPath.length - 1] as { predicates?: Array<{ value?: string }> } | undefined;
  const predicate = Array.isArray(descriptor?.predicates)
    ? descriptor.predicates[descriptor.predicates.length - 1]
    : undefined;
  return typeof predicate?.value === 'string' ? predicate.value : undefined;
}

function normalizeSeverity(term: { value: string } | undefined): string {
  const value = term?.value ?? `${SHACL_NS}Violation`;
  return value.startsWith(SHACL_NS) ? value.slice(SHACL_NS.length) : value;
}

async function createAdapter(): Promise<ShaclExecutionPort> {
  const [{ Validator }, { validations, targetResolvers }] = await Promise.all([
    import('shacl-engine'),
    import('shacl-engine/sparql.js'),
  ]);
  return {
    engine: SHACL_ENGINE_SPARQL_ENGINE_ID,
    async validate(input: { data_nquads: string; shapes_turtle: string }): Promise<ShaclValidationReport> {
      const shapes = new Store(new Parser({ format: 'text/turtle' }).parse(input.shapes_turtle));
      const data = new Store(new Parser({ format: 'application/n-quads' }).parse(input.data_nquads));
      const validator = new Validator(shapes, {
        factory: DataFactory,
        details: true,
        // ALWAYS both: without the plugin, SPARQL features are silently
        // ignored and violating data conforms.
        validations,
        targetResolvers,
      });
      const report = await validator.validate({ dataset: data });
      return {
        conforms: report.conforms,
        results: (report.results ?? []).map((result) => {
          const path = extractPathIri(result.path);
          return {
            focusNode: result.focusNode?.value ?? '',
            ...(path ? { path } : {}),
            sourceConstraintComponent: (result.constraintComponent?.value ?? '').startsWith(SHACL_NS)
              ? (result.constraintComponent?.value ?? '').slice(SHACL_NS.length)
              : (result.constraintComponent?.value ?? ''),
            ...(result.message?.[0]?.value ? { message: result.message[0].value } : {}),
            severity: normalizeSeverity(result.severity),
            ...(result.value?.value !== undefined ? { value: result.value.value } : {}),
          };
        }),
      };
    },
  };
}

/** Lazily-created singleton adapter (Comunica chain loads on first use). */
export function createShaclEngineSparqlAdapter(): Promise<ShaclExecutionPort> {
  cachedAdapter ??= createAdapter();
  return cachedAdapter;
}
