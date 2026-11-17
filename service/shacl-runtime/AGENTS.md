# service/shacl-runtime — agent notes

Optional sidecar that executes SHACL-AF features (rules, SPARQL functions,
custom SPARQL-based constraint components) with pyshacl for
`service/registry`. Registry-side integration is documented in the root
`AGENTS.md`; the contract in `README.md` is the boundary.

Rules for changes here:
- never enable non-advanced mode: without `advanced=True` pyshacl silently
  skips rules/functions and violating data would read as conforming
- the sidecar receives prepared shapes only; do not add `sh:pattern`
  execution here (the registry owns regex via RE2)
- keep results deterministic (sorted) and raw-IRI; the registry adapter
  performs vocabulary normalization
- dependencies stay hash-pinned (`requirements*.txt` via pip-compile);
  run `pip_audit -r requirements.txt` and the pytest suite before shipping
