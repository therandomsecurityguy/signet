/**
 * Local type declarations for rdf-validate-shacl (no bundled types;
 * DefinitelyTyped trails the 0.6.x async API). Mirrors only the surface the
 * registry adapter uses.
 */
declare module 'rdf-validate-shacl' {
  export type ShaclTerm = { value: string };

  export type ShaclValidationResult = {
    focusNode: ShaclTerm;
    path?: ShaclTerm;
    sourceConstraintComponent: ShaclTerm;
    sourceShape?: ShaclTerm;
    message?: ShaclTerm[];
    severity: ShaclTerm;
    value?: ShaclTerm;
  };

  export type ShaclValidationReport = {
    conforms: boolean;
    results?: ShaclValidationResult[];
  };

  export default class SHACLValidator {
    constructor(shapes: unknown, options?: Record<string, unknown>);
    validate(dataset: unknown): Promise<ShaclValidationReport>;
  }
}
