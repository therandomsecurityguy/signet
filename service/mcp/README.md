## `service/mcp` — Agent Data Access Gateway (MCP + Tool API)

This package is the **Agent Data Access Gateway**:
- **Canonical Tool API** (source of truth)
- **MCP adapter** (thin; added in a later phase)

Registry note:
- `service/mcp` is the canonical AI-facing plane
- registry reads now flow through the shared internal registry core rooted in `service/registry`
- `service/mcp` does not call `service/api` over HTTP

### Get value fast

```bash
cd signet/service/mcp
npm install
npm run dev
```

Health check:

```bash
curl -s http://localhost:3000/healthz
curl -s http://localhost:3000/v1/tools -H "Authorization: Bearer <token>"
```

Create a Stage 1 API key:

```bash
cd signet/service/mcp
npm run create-api-key -- --owner-label "Jane Doe"
```

Use it as:

```bash
Authorization: Bearer <token>
```

### Current status
- **PHASE 0**: service skeleton is green (Hono + Pino + minimal OTel + tests).
- **PHASE 1**: Tool API + tool registry + stub connector are implemented (tests included).
- **PHASE 2**: Stage 1 API key auth + persistent audit store + migrations (green).
- **PHASE 3**: SQL read-only validator + limits (timeout/rows/bytes) (green).
- registry ingestion + graph-backed agent/skill tools (mock-first) are implemented.
- registry reads now fail explicitly when entities or artifacts are missing.
- real `/mcp` black-box coverage now exists for registry discovery/load behavior.
- registry bootstrap now supports repeatable ingest into the configured graph backend (`json_file` or `sparql`) instead of an in-memory-only run.

### Mocked connections (worksession 02)
To stay unblocked while wiring end-to-end seams, warehouse connections and Okta validation may run in **MOCK** mode by default.

See:
- `../../../_devagents/signet/projects/worksesseion-02/`
- `../../../_devagents/signet/projects/worksession-03.md` (reserved for real credentials & exact setup)

### Endpoints (today)
- `GET /healthz`
- `GET /readyz`
- `ALL /mcp` (Streamable HTTP transport)
- `GET /v1/tools`
- `POST /v1/tools/{toolName}:execute`

### Tools
- `data.query`
- `data.list_tables`
- `data.describe_table`

Registry (graph + CAS, mock-first):
- `registry.list_agents`
- `registry.get_agent`
- `registry.list_skills`
- `registry.get_skill`
- `registry.get_artifact`
- `registry.get_provenance`
- `registry.search`

Current registry behavior:
- missing registry entities now return explicit not-found errors instead of empty placeholders
- registry tools remain read-only and now participate in the same policy/audit envelope as the warehouse tools

### Run locally

```bash
cd signet/service/mcp
npm install
npm run dev
```

Important local env defaults:
- `DATABASE_URL=file:./var/signet-mcp.db`
- `AUTH_MODE=api_key`
- `OKTA_MODE=mock`
- `REGISTRY_GRAPH_BACKEND=json_file`
- `REGISTRY_GRAPH_STATE_FILE=../../data/registry/graph/registry-state.json`
- `REGISTRY_OBJECTS_DIR=../../data/registry/objects`

### Run with Docker Compose (system infra)

```bash
cd signet/infra
make up
```

MCP will be available at:
- `http://localhost:3000`

If port `3000` is already in use:

```bash
MCP_PORT=3300 make up
```

Direct compose usage remains available via:

```bash
docker compose -f docker-compose.yml -f docker-compose.override.yml up --build -d
```

See also:
- `docs/governance-model.md`
- `docs/local-development.md`
- `docs/service-map.md`

### Auth modes (Stage 1 + Stage 2)

- **Stage 1 (default)**: `AUTH_MODE=api_key` (Bearer token from `npm run create-api-key`)
- **Stage 2 (mock-first)**: `AUTH_MODE=okta` and `OKTA_MODE=mock` (any Bearer token is accepted)
- **Dual**: `AUTH_MODE=dual` (tokens starting with `agk_` are treated as API keys; others as Okta)

### OAuth protected resource metadata (Stage 2)

- `GET /.well-known/oauth-protected-resource`

### Cognitive layer (context management)

The gateway includes an opt-in cognitive layer that estimates the token cost of
each tool result and, when it would exceed a configured LLM context budget,
returns a summarized form instead of the full payload. Summaries are cached
ephemerally (keyed by principal + tool + input hash) so repeated identical
requests do not re-summarize.

Config (env):
- `COGNITIVE_LAYER_ENABLED` — set to `true` to enable (default: disabled)
- `CONTEXT_BUDGET_TOKENS` — token budget per tool result (default: `8000`)
- `COGNITIVE_CACHE_TTL_MS` — summary cache TTL (default: `300000`)
- `COGNITIVE_CACHE_MAX_ENTRIES` — summary cache max entries (default: `500`)

The cognitive layer is read-only and non-blocking: it shapes the result after
execution and never changes tool behavior, policy, or audit.

### Create a Stage 1 API key

```bash
npm run create-api-key -- --owner-label "Jane Doe"
```

### Test

```bash
npm run lint
npm run typecheck
npm test
```

### Registry ingest (local)

Ingest the checked-in `agent/` and `skills/` roots into the configured registry graph backend plus CAS:

```bash
cd signet/service/mcp
npm run registry-ingest
```

Useful flags:

```bash
npm run registry-ingest -- --agent-root ./agent --skill-root ./skills
npm run registry-ingest -- --objects-dir ../../data/registry/objects
```

Default local durable path:
- `REGISTRY_GRAPH_BACKEND=json_file`
- `REGISTRY_GRAPH_STATE_FILE=../../data/registry/graph/registry-state.json`
- `REGISTRY_ARTIFACT_BACKEND=fs`
- `REGISTRY_OBJECTS_DIR=../../data/registry/objects`

Optional SPARQL lane:
- `REGISTRY_GRAPH_BACKEND=sparql`
- `REGISTRY_SPARQL_QUERY_URL=http://localhost:3030/registry/sparql`
- `REGISTRY_SPARQL_UPDATE_URL=http://localhost:3030/registry/update`
- `REGISTRY_SPARQL_USERNAME=admin`
- `REGISTRY_SPARQL_PASSWORD=admin`

Optional JSON-file fallback:

```bash
REGISTRY_GRAPH_BACKEND=json_file \
REGISTRY_GRAPH_STATE_FILE=../../data/registry/graph/registry-state.json \
npm run registry-ingest
```

Optional S3 artifact path:

```bash
REGISTRY_ARTIFACT_BACKEND=s3 \
REGISTRY_S3_BUCKET=signet-artifacts \
REGISTRY_S3_PREFIX=signet/dev \
REGISTRY_S3_REGION=us-west-2 \
npm run registry-ingest
```

The Terraform module/example under `infra/terraform/` now outputs the equivalent env block for copy/paste or remote-state consumption.

This is the current repeatable beta bootstrap path for registry discovery/load data.

Important current bootstrap note:
- this ingest CLI is useful for durable content population from checked-in roots
- but the first operator bootstrap workflow is moving toward lifecycle-aware seeding through `service/api`
- the intended operator sequence is:
  1. seed lifecycle-aware skills through `service/api`
  2. seed agents that reference those skills through `service/api`
  3. verify discovery/load through the real `/mcp` surface
- the current operator wrapper for that sequence now lives under `client/registry-cli`
- that operator wrapper now supports richer multi-pack bootstrap manifests and a separate real-Okta verification lane for the registry-admin surface

### Governance note
This service is a read-only trust surface, not the publication authority.

Current governance expectations:
- `registry.*` tools surface publication and trust metadata from the shared registry core
- MCP reads can expose active publication snapshots and linked artifacts
- MCP does not approve, publish, certify, revoke, or supersede registry state
- agent and skill read contracts may now include active publication snapshot details in addition to logical identity details

Semantic-governance evidence flows through the shared registry core and appears here as readable evidence, not as write behavior: `registry.get_provenance` exposes PROV-O provenance, and verification payloads surface policy/ontology validation and dual canonical-signature results. Future governance layers should follow the same rule.

### Quick Tool API examples

```bash
curl -s localhost:3000/v1/tools \
  -H "Authorization: Bearer <token>"

curl -s -X POST localhost:3000/v1/tools/data.query:execute \
  -H 'content-type: application/json' \
  -H 'x-agent-client: curl' \
  -H "Authorization: Bearer <token>" \
  -d '{"data_source":"snowflake","sql":"select 1"}'
```

### MCP endpoint (local)

This server exposes a Streamable HTTP MCP endpoint at:
- `http://localhost:3000/mcp`

Stage 1 auth is the same bearer token header:
- `Authorization: Bearer <token>`

In Okta mode, unauthenticated `/mcp` requests include a `WWW-Authenticate` challenge pointing at the protected resource metadata endpoint.

