Programmatic HTTP API for registry operations.

Use this service for:
- CICD and GitHub Actions integrations
- scanners and CLIs
- future CRUD-style entity operations over the registry

Do not turn this service into:
- an MCP transport
- a Tool API for warehouse access
- the home of graph/CAS persistence internals

Current bootstrap scope:
- health endpoints
- service boundary descriptor at `GET /v1`
- local infra under `service/api/infra/`
- first versioned `agents` and `skills` metadata API slices
- first lifecycle-oriented skill management operations

Current API rules worth preserving:
- `POST /v1/agents` may link existing skills by `skill_key` or `skill_urn`
- agent creation is idempotent for the same normalized payload
- conflicting re-creates return `409`
- local API metadata writes should default to the persistent JSON-file graph backend unless deliberately overridden for tests/debugging
- write routes currently require auth and must remain audited even on denial/failure paths
- lifecycle operations should remain thin wrappers over the shared registry core in `service/registry`

Testing guidance:
- keep at least one black-box e2e HTTP test over the public API surface
- use that test to freeze behavior before swapping persistence backends
- keep `json_file` as the default local backend even when `sparql` is wired as an optional runtime mode
- when exercising the live SPARQL path locally, prefer the env-gated `test:live-sparql` path against the compose-managed Fuseki service
