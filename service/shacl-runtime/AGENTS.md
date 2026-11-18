# service/shacl-runtime — agent notes

Optional sidecar that executes SHACL-AF features (rules, SPARQL functions,
custom SPARQL-based constraint components) with pyshacl for
`service/registry`. Registry-side integration is documented in the root
`AGENTS.md`; the contract in `README.md` is the boundary.

Rules for changes here:
- pyshacl runs ONLY in worker subprocesses (`worker.py`, spawned by
  `server.py`) under rlimits — never add an in-process (thread) execution
  path; the process boundary + hard-kill timeout is the isolation model
- rlimits stay enforced in the child (`MAX_MEMORY_MB` / `MAX_CPU_SECONDS` /
  `MAX_NOFILE`, `RLIMIT_CORE=0`); do not add an `RLIMIT_FSIZE` cap — a
  worker's stderr can be a regular file (container log capture), and FSIZE
  kills the worker with SIGXFSZ on its first diagnostic write
- never enable non-advanced mode: without `advanced=True` pyshacl silently
  skips rules/functions and violating data would read as conforming
- NEVER permit `SERVICE` in any SPARQL-bearing literal: pyshacl executes it
  from rules (probe-proven outbound connection = SSRF); the runtime rejects
  it before execution
- the sidecar receives prepared shapes only; do not add `sh:pattern`
  execution here (the registry owns regex via RE2)
- keep results deterministic (sorted) and raw-IRI; the registry adapter
  performs vocabulary normalization
- keep auth constant-time and every limit (body/timeout/queue) enforced;
  deployments require `SHACL_RUNTIME_TOKEN` + cluster-internal exposure
- dependencies stay hash-pinned (`requirements*.txt` via pip-compile);
  run `pip_audit -r requirements.txt -r requirements-dev.txt` and the
  pytest suite before shipping
