/**
 * Local type declarations for shacl-engine (no bundled types; the registry
 * uses it behind the SHACL execution port for SPARQL constraints/targets).
 * Mirrors only the surface the adapter uses; results are normalized
 * defensively, so field access goes through narrow helpers there.
 */
declare module 'shacl-engine' {
  export type ShaclEngineTerm = { termType?: string; value: string };
  export type ShaclEnginePathDescriptor = {
    predicates?: ShaclEngineTerm[];
  };
  export type ShaclEngineResult = {
    focusNode?: ShaclEngineTerm;
    path?: unknown;
    constraintComponent?: ShaclEngineTerm;
    severity?: ShaclEngineTerm;
    message?: ShaclEngineTerm[];
    value?: ShaclEngineTerm;
  };
  export type ShaclEngineReport = {
    conforms: boolean;
    results: ShaclEngineResult[];
  };
  export class Validator {
    constructor(shapes: unknown, options?: Record<string, unknown>);
    validate(input: { dataset: unknown }): Promise<ShaclEngineReport>;
  }
}

declare module 'shacl-engine/sparql.js' {
  export const validations: Map<unknown, unknown>;
  export const targetResolvers: Map<unknown, unknown>;
}
