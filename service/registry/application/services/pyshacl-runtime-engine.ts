/**
 * pyshacl runtime sidecar adapter (SHACL-AF execution).
 *
 * The registry's third SHACL execution engine, selected for authored
 * policies that use SHACL-AF constructs the in-process engines cannot
 * execute (rules, SPARQL functions, custom SPARQL-based constraint
 * components). It calls the optional `service/shacl-runtime` sidecar, which
 * runs pyshacl 0.40.2 with `advanced=True` and rejects federated queries
 * (SERVICE) before execution.
 *
 * Failure taxonomy (the registry maps all of these to fail-closed
 * violations — a governance gate must never pass when validation could not
 * run):
 * - networking/timeout/5xx -> ShaclRuntimeEngineError('SHACL_RUNTIME_UNAVAILABLE')
 * - structured sidecar errors -> ShaclRuntimeEngineError with the sidecar
 *   code preserved in `sidecar_code`
 */

import { fetchWithRetry } from './fetch-with-retry.js';
import type { ShaclExecutionPort, ShaclValidationReport } from './shacl-execution-port.js';

const SHACL_NS = 'http://www.w3.org/ns/shacl#';

/** Recorded in validation report artifacts. A test pins this to the
 * sidecar's requirements.txt. */
export const PYSHACL_RUNTIME_ENGINE_ID = 'pyshacl@0.40.2+shacl-runtime';

/** Generation time allowance for the sidecar call (the sidecar's own default
 * validate timeout is 30s and returns a structured 504 before this). */
const RUNTIME_CALL_TIMEOUT_MS = 40_000;

export type ShaclRuntimeConfig = {
  url: string;
  token?: string;
};

export class ShaclRuntimeEngineError extends Error {
  readonly sidecar_code?: string;

  constructor(message: string, sidecar_code?: string) {
    super(message);
    this.name = 'ShaclRuntimeEngineError';
    if (sidecar_code !== undefined) {
      this.sidecar_code = sidecar_code;
    }
  }
}

type SidecarRow = {
  focusNode?: unknown;
  path?: unknown;
  sourceConstraintComponent?: unknown;
  severity?: unknown;
  message?: unknown;
  value?: unknown;
};

function stripNamespace(value: string): string {
  return value.startsWith(SHACL_NS) ? value.slice(SHACL_NS.length) : value;
}

export function createPyshaclRuntimeEngine(config: ShaclRuntimeConfig): ShaclExecutionPort {
  return {
    engine: PYSHACL_RUNTIME_ENGINE_ID,
    async validate(input: { data_nquads: string; shapes_turtle: string }): Promise<ShaclValidationReport> {
      let response: Response;
      try {
        response = await fetchWithRetry(
          new URL('/v1/validate', config.url),
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              accept: 'application/json',
              ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
            },
            body: JSON.stringify({
              data_nquads: input.data_nquads,
              shapes_turtle: input.shapes_turtle,
            }),
          },
          // No retries: an expensive validation must produce one verdict, and
          // the caller fails closed on any error.
          { retries: 0, timeoutMs: RUNTIME_CALL_TIMEOUT_MS },
        );
      } catch (err) {
        throw new ShaclRuntimeEngineError(
          `SHACL-AF runtime unreachable: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const body = (await response.json().catch(() => undefined)) as
        | { conforms?: unknown; results?: unknown; error?: { code?: unknown; message?: unknown } }
        | undefined;
      if (!response.ok) {
        const sidecarCode = typeof body?.error?.code === 'string' ? body.error.code : undefined;
        const message = typeof body?.error?.message === 'string' ? body.error.message : `HTTP ${response.status}`;
        throw new ShaclRuntimeEngineError(
          `SHACL-AF runtime rejected the validation (${sidecarCode ?? response.status}): ${message}`,
          sidecarCode,
        );
      }
      if (typeof body?.conforms !== 'boolean' || !Array.isArray(body?.results)) {
        throw new ShaclRuntimeEngineError('SHACL-AF runtime returned a malformed response.');
      }

      return {
        conforms: body.conforms,
        results: (body.results as SidecarRow[]).map((row) => {
          const focusNode = typeof row.focusNode === 'string' ? row.focusNode : '';
          const path = typeof row.path === 'string' ? row.path : undefined;
          const component = typeof row.sourceConstraintComponent === 'string' ? row.sourceConstraintComponent : '';
          const severity = typeof row.severity === 'string' ? row.severity : '';
          const message = typeof row.message === 'string' ? row.message : undefined;
          const value = typeof row.value === 'string' ? row.value : undefined;
          return {
            focusNode,
            ...(path ? { path } : {}),
            sourceConstraintComponent: stripNamespace(component),
            ...(message ? { message } : {}),
            severity: stripNamespace(severity) || 'Violation',
            ...(value !== undefined ? { value } : {}),
          };
        }),
      };
    },
  };
}
