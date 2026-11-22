# SHACL-AF execution: in-process engine decision record

Status: **decided** (kept out-of-process). Reference: this document supersedes
the former proposed-next item "an in-process SHACL-AF engine (graph mutation
needs an inference-stage design)".

## Context

Authored policies may use SHACL-AF constructs — rules (`sh:TripleRule`,
`sh:SPARQLRule`), SPARQL functions (`sh:SPARQLFunction`), and custom
SPARQL-based constraint components (`sh:ConstraintComponent`) — plus SPARQL
node-shape constraints and SPARQL-based targets. Execution is split by
capability, one engine per shapes document:

| Layer | Engine | Where |
|---|---|---|
| SHACL Core constraints | `rdf-validate-shacl` | in-process |
| `sh:sparql` constraints / SPARQL targets | `shacl-engine` + its SPARQL plugin | in-process |
| SHACL-AF (rules, functions, components) | pyshacl 0.40.2 (`advanced=True`) | `service/shacl-runtime` sidecar |

The sidecar receives **prepared shapes only** (targeting rewritten to the
validated focus nodes, `sh:pattern` stripped — RE2 owns patterns), runs every
validation in an rlimit-bounded worker subprocess, hard-kills on timeout, and
all layers fail closed (an AF policy without a configured/healthy runtime is
a `ShaclRuntimeConstraintComponent` violation, never a silent conform).

## What "in-process SHACL-AF" would actually require

Not an engine swap — a new **inference stage** plus engine-level machinery:

1. **Inference stage.** SHACL-AF rules *mutate* the data graph: rules must
   reach a fixpoint over a mutable clone of the dataset **before** constraint
   validation, and the validators then see the inferred triples. Today's
   in-process pipeline is a pure step (`dataset → engine → results`); rule
   execution would sit before it, with deterministic iteration order, triple
   deduplication, and iteration/step budgets.
2. **Function and component dispatch.** `sh:SPARQLFunction` registration and
   custom `sh:ConstraintComponent` dispatch (parameter binding, validator
   selection) are engine-level features. The engines this repo depends on
   implement constraint validation — including `sh:sparql` constraints and
   targets — but not rule fixpoints, function registration, or component
   dispatch.
3. **Parity evidence.** The Core swap shipped with a 72-case legacy-parity
   suite; AF parity against pyshacl (rule application semantics, error
   surfaces, result projection) would need its own fixture suite to be
   believable for a governance gate.
4. **Resource safety.** Rule fixpoints multiply the adversarial surface
   (production chains, pathological graphs). The out-of-process model already
   answers this with process isolation, rlimits, hard-kill timeouts, and
   capacity accounting; an in-process engine would need equivalent budgets
   and cancellation, which — for JavaScript — effectively means re-creating
   the sidecar's guarantees inside the validation process.
5. **Invariant preservation.** RE2 pattern ownership, `SERVICE`/`REGEX(`
   dual-scan refusal, prepared-shapes-only inputs, and fail-closed gating all
   exist around the current boundary; an inference stage must not weaken any
   of them.

## Options

- **A — implement in-process AF** (rule interpreter + fixpoint stage atop
  `shacl-engine`, function/component dispatch, parity suite, budgets). Large,
  spec-deep, and re-introduces the in-process risk surface the sidecar
  hardening removed.
- **B — keep AF execution out-of-process** (chosen). The sidecar is
  implemented, fixture-locked against the real ecosystem (signed notes,
  tlog-tiles, pyshacl 0.40.2), hardened (subprocess rlimits + hard kill), and
  one configuration away (compose profile `shacl-af`, `shaclRuntime.enabled`
  in the chart, `SHACL_RUNTIME_URL` on `service/api`).
- **C — hybrid**: run AF in-process only for "safe" rule shapes with a
  static analyzer. Rejected: a governance gate that silently executes
  different semantics per shape is worse than a uniform, isolated executor.

## Decision

AF execution stays out-of-process (option B). The sidecar is the execution
path; this is not a temporary shim but the safety model: a validating process
permanently separate from the control plane, with process-level resource
bounds a JavaScript engine would have to emulate.

## Revisit triggers

- a maintained, spec-conformant JS SHACL-AF engine (rules/fixpoints,
  functions, components) becomes available to lean on, **or**
- deployments structurally unable to run the sidecar need AF execution
  (today: not the case — the sidecar is a single optional container), **or**
- measured sidecar round-trip cost becomes material for interactive flows
  (today: validations are seconds-scale and sidecar calls are sub-second).

Any in-process engine must land behind the existing execution port with its
own parity suite, resource budgets, and the invariants in §5 preserved.
