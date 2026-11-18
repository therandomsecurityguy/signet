# `service/shacl-runtime` — SHACL-AF runtime sidecar

Executes authored SHACL shapes with **pyshacl's advanced features** —
SHACL-AF rules (`sh:TripleRule`, `sh:SPARQLRule`), SPARQL functions
(`sh:SPARQLFunction`), and custom SPARQL-based constraint components
(`sh:ConstraintComponent` + `sh:parameter` + `sh:propertyValidator`) — the
features no in-process JS engine in the registry implements.

The registry's `service/registry` selects this runtime **per shapes
document** (any `sh:rule` / `sh:function` / custom component) and sends
**prepared shapes only**: targeting is already rewritten (`sh:targetNode`
injection) and `sh:pattern` is stripped and executed by the registry's
RE2 layer. The sidecar never evaluates patterns, and `advanced=True` is
always passed — without it pyshacl would silently skip rules and functions,
which would read as "conforms".

## Contract

`POST /v1/validate` with `{ data_nquads, shapes_turtle }` returns
`{ conforms, results: [{ focusNode, path?, sourceConstraintComponent,
severity, message?, value? }] }` with **raw IRIs** (the registry adapter
normalizes) and deterministic ordering. Errors are structured:

- `400 SHAPES_PARSE_ERROR` / `400 DATA_PARSE_ERROR` / `400 VALIDATION_ERROR`
- `400 FEDERATED_QUERY_REJECTED` (any `SERVICE` clause in a SPARQL-bearing
  literal; see Hardening notes)
- `401 AUTH_UNAUTHORIZED` (only when `SHACL_RUNTIME_TOKEN` is set)
- `413 PAYLOAD_TOO_LARGE`
- `422 VALIDATION_FAILURE` (pyshacl reported a spec-level failure)
- `503 SHACL_RUNTIME_BUSY` (workers + queue at capacity; retry shortly)
- `504 VALIDATION_TIMEOUT` (A worker thread keeps running after a timeout —
  Python cannot cancel it; it still holds its capacity slot and concurrency
  is bounded by `MAX_CONCURRENCY + QUEUE_LIMIT`.)

`GET /healthz` reports ok + engine id.

## Configuration

| Env | Default | Notes |
|---|---|---|
| `HOST` / `PORT` | `0.0.0.0` / `3300` | |
| `SHACL_RUNTIME_TOKEN` | *(empty = open)* | Bearer required on `/v1/validate` when set; compared constant-time; the registry presents the same value. **Deployments must set it.** |
| `VALIDATE_TIMEOUT_SECONDS` | `30` | Per-request wall clock for the response; unbounded rule fixpoints are documented, not statically bounded |
| `REQUEST_TIMEOUT_SECONDS` | `15` | Per-connection socket timeout (slow or stalled clients are dropped) |
| `MAX_BODY_BYTES` | `2000000` | |
| `MAX_CONCURRENCY` | `4` | Validation worker threads |
| `QUEUE_LIMIT` | `32` | Pending requests before `503 SHACL_RUNTIME_BUSY` |

## Hardening notes

- **Federated queries are rejected everywhere.** pyshacl refuses `SERVICE`
  in `sh:sparql` constraints, but probe-testing showed a `sh:SPARQLRule`
  CONSTRUCT with `SERVICE` is EXECUTED — the sidecar performs the outbound
  request (SSRF). The runtime therefore scans every SPARQL-bearing literal
  (`sh:select`, `sh:construct`, `sh:ask`, `sh:update` — constraints,
  targets, rules, functions, validators) and rejects `SERVICE` before
  execution, on both raw and comment-stripped text (the stripper alone can
  be evaded by a `#` inside a string; over-rejection fails closed). The
  registry refuses `SERVICE` at policy registration as well.
- **No RDF-driven code execution**: pyshacl does not execute `sh:js` or any
  language-extension hooks; only SPARQL runs.
- **Resource isolation is bounded, not absolute**: timeouts bound the
  response, not the worker (Python cannot cancel threads); runaway work
  holds capacity slots and is capped by `MAX_CONCURRENCY + QUEUE_LIMIT`.
  Hard cancellation/isolation would require subprocess execution with
  rlimits — tracked as a follow-up.
- **Deployment**: run cluster-internal only (no ingress), with
  `SHACL_RUNTIME_TOKEN` set from a secret; the compose profile publishes a
  host port for local development, where the default is open.

## Run

```bash
cd service/shacl-runtime
python3 -m venv .venv && . .venv/bin/activate
pip install --require-hashes -r requirements.txt -r requirements-dev.txt
python server.py
# or via compose (optional profile):
# cd infra && docker compose --profile shacl-af up shacl-runtime
```

`infra/.env.example` documents the environment; copy it to `infra/.env`
and never commit tokens.

## Test

```bash
cd service/shacl-runtime
python -m pytest tests -q
python -m pip_audit -r requirements.txt
```

Dependencies are hash-pinned (`pip-compile --generate-hashes`); regenerate
with the same tool when bumping `requirements*.in`.
