## Local infra (Docker Compose)

This directory contains the system-level local infra wiring for `signet`.

### Get value fast

```bash
cd signet/infra
make up
```

Smoke check:

```bash
curl -s http://localhost:3000/healthz
curl -s http://localhost:3100/healthz
curl -s http://localhost:3200/healthz
```

### Compose files
- `docker-compose.yml`: base services and shared system wiring.
- `docker-compose.override.yml`: local-only ergonomics (TTY, `host.docker.internal`, delegated mounts, watch-friendly env).
- `.env`: compose-level variables (for example `MCP_PORT`).

### Services
- `mcp`: `service/mcp` runtime (Hono app + Tool API + MCP endpoint).
- `api`: `service/api` runtime (programmatic HTTP API bootstrap for machine clients).
- `webapp`: `service/webapp/knowledge-manager` runtime (thin human-facing launchpad over `service/api`, now with durable SQLite-backed browser sessions).
- `registry-graph`: local Apache Jena Fuseki service for the optional SPARQL-backed graph seam.
- `registry`: `service/registry` dev container (domain/graph/CAS workspace seam for future runtime).
- `vocbench`: optional local VocBench / Semantic Turkey companion service under the `knowledge` profile.

### Fast local development defaults
- Shared source mounts:
  - `../service/mcp` -> `/workspace/service/mcp`
  - `../service/registry` -> `/workspace/service/registry`
- `../service/webapp/knowledge-manager` -> `/workspace/service/webapp/knowledge-manager`
- Shared data mount:
  - `../data` -> `/workspace/data`
- Named volume:
  - `mcp_node_modules` for faster restarts/rebuilds and host/OS independence.
- Shared network:
  - `agents_registry_net`

### Env file wiring
- Compose-level vars: `infra/.env`
- MCP vars: `service/mcp/infra/.env`
- API vars: `service/api/infra/.env`
- Webapp vars: `service/webapp/knowledge-manager/infra/.env`
- Registry vars: `service/registry/infra/.env`
- Fuseki vars: `service/registry/infra/fuseki.env`

Copy from examples when needed:
- `infra/.env.example`
- `service/mcp/infra/.env.example`
- `service/api/infra/.env.example`
- `service/webapp/knowledge-manager/infra/.env.example`
- `service/registry/infra/.env.example`
- `service/registry/infra/fuseki.env.example`

### Run

```bash
cd signet/infra
make up
```

Recommended bootstrap:
- copy or review the `*.env.example` files before your first run
- keep `service/api` on `json_file` backend for everyday local work
- switch to `sparql` only when you explicitly want to exercise the Fuseki path
- keep VocBench / Semantic Turkey off by default unless you explicitly want the knowledge-authoring companion
- the webapp persists browser sessions under `/workspace/data/webapp/knowledge-manager.db`

If port `3000` is already in use:

```bash
MCP_PORT=3300 make up
```

If you also want the optional knowledge-authoring companion:

```bash
make up-knowledge
```

### Useful commands

```bash
make ps
make logs
make logs S=mcp
make logs S=api
make logs S=webapp
make logs S=registry-graph
make logs S=vocbench
make shell-mcp
make shell-api
make shell-webapp
make shell-registry
make down
```

Direct compose usage remains valid:

```bash
docker compose -f docker-compose.yml -f docker-compose.override.yml up --build -d
```

### Related docs
- `docs/local-development.md`
- `docs/service-map.md`
- `service/api/README.md`
- `service/mcp/README.md`
- `service/registry/README.md`
- `service/webapp/README.md`
- `service/webapp/knowledge-manager/README.md`

### Optional local SPARQL graph
Fuseki/Jena is available locally at:
- `http://localhost:${FUSEKI_PORT:-3030}/`

Expected dataset endpoints:
- query: `http://localhost:${FUSEKI_PORT:-3030}/registry/sparql`
- update: `http://localhost:${FUSEKI_PORT:-3030}/registry/update`

Local default credentials:
- username: `admin`
- password: value from `service/registry/infra/fuseki.env`

If you want the compose-managed API service to use Fuseki instead of `json_file`, set in `service/api/infra/.env`:

```bash
REGISTRY_GRAPH_BACKEND=sparql
REGISTRY_SPARQL_QUERY_URL=http://registry-graph:3030/registry/sparql
REGISTRY_SPARQL_UPDATE_URL=http://registry-graph:3030/registry/update
REGISTRY_SPARQL_USERNAME=admin
REGISTRY_SPARQL_PASSWORD=admin
```

### Optional local VocBench / Semantic Turkey
The knowledge-authoring companion is intentionally optional.

Its local operator path is:
- prepare runtime files using the guide in `service/webapp/knowledge-manager/VOCBENCH_SEMANTIC_TURKEY_LOCAL_DEV_GUIDE.md`
- then start the optional compose profile with:

```bash
make up-knowledge
```

Expected UI URL:
- `http://localhost:${VOCBENCH_PORT:-1979}/vocbench3`
