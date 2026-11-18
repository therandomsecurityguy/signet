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
- `500 VALIDATION_ABORTED` (the worker died mid-validation: crash or a
  resource limit; the pool recycles — fail closed)
- `503 SHACL_RUNTIME_BUSY` (workers + queue at capacity; retry shortly)
- `504 VALIDATION_TIMEOUT` (the worker was hard-killed at the configured
  timeout; no runaway work lingers and capacity is released immediately)
- `507 RESOURCE_LIMIT` (validation exceeded the worker memory limit)

`GET /healthz` reports ok + engine id + worker stats
(`{"workers": {"size", "alive", "killed", "aborted"}}`).

## Configuration

| Env | Default | Notes |
|---|---|---|
| `HOST` / `PORT` | `0.0.0.0` / `3300` | |
| `SHACL_RUNTIME_TOKEN` | *(empty = open)* | Bearer required on `/v1/validate` when set; compared constant-time; the registry presents the same value. **Deployments must set it.** |
| `VALIDATE_TIMEOUT_SECONDS` | `30` | Per-request wall clock; on expiry the worker subprocess is hard-killed and recycled |
| `REQUEST_TIMEOUT_SECONDS` | `15` | Per-connection socket timeout (slow or stalled clients are dropped) |
| `MAX_BODY_BYTES` | `2000000` | |
| `MAX_CONCURRENCY` | `4` | Worker subprocesses (one validation in flight each) |
| `QUEUE_LIMIT` | `32` | Pending requests before `503 SHACL_RUNTIME_BUSY` |
| `MAX_MEMORY_MB` | `1024` | Worker address-space cap (`RLIMIT_AS`). Enforced on Linux; the macOS kernel rejects the limit (warning logged, execution continues — kill/CPU limits still apply) |
| `MAX_CPU_SECONDS` | `300` | Worker CPU backstop (`RLIMIT_CPU`); workers are retired at half the budget |
| `MAX_NOFILE` | `64` | Worker FD cap (`RLIMIT_NOFILE`) |

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
- **Resource isolation is process-level.** Every validation runs in a worker
  subprocess (forkserver-preloaded, `engine`/`worker` imported once) under
  rlimits: memory cap (best-effort per platform), CPU backstop, bounded FDs,
  and no core dumps (`RLIMIT_CORE=0`; `RLIMIT_FSIZE` is deliberately *not*
  zeroed — the worker's stderr may be a regular file under container log
  capture or test harnesses, and an FSIZE cap would kill the worker with
  `SIGXFSZ` on its first diagnostic write). Timeouts `SIGKILL` the worker,
  so no runaway work lingers or holds capacity; workers are recycled after a
  memory-limit event and retired at half their CPU budget. This is not a
  syscall sandbox: there is no seccomp/namespace isolation and filesystem
  read access is unchanged — process isolation is a layered defense, and the
  `SERVICE` rejection remains the primary outbound-request guard.
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
