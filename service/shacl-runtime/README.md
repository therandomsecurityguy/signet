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
- `401 AUTH_UNAUTHORIZED` (only when `SHACL_RUNTIME_TOKEN` is set)
- `413 PAYLOAD_TOO_LARGE`
- `422 VALIDATION_FAILURE` (pyshacl reported a spec-level failure)
- `504 VALIDATION_TIMEOUT` (A worker thread keeps running after a timeout —
  Python cannot cancel it; concurrency is capped by `MAX_CONCURRENCY`.)

`GET /healthz` reports ok + engine id.

## Configuration

| Env | Default | Notes |
|---|---|---|
| `HOST` / `PORT` | `0.0.0.0` / `3300` | |
| `SHACL_RUNTIME_TOKEN` | *(empty = open)* | Bearer required on `/v1/validate` when set; the registry presents the same value |
| `VALIDATE_TIMEOUT_SECONDS` | `30` | Per-request wall clock for the response; unbounded rule fixpoints are documented, not statically bounded |
| `MAX_BODY_BYTES` | `2000000` | |
| `MAX_CONCURRENCY` | `4` | Validation worker threads |

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
