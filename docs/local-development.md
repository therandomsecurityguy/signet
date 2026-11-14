## Local Development

This document is the main human operator guide for running **Cachet** (formerly `agents-registry`) locally.

### Default entrypoint
Use the system infra wrapper from `infra/`:

```bash
cd cachet/infra
make up
```

This uses:
- `infra/docker-compose.yml`
- `infra/docker-compose.override.yml`

### Port override
If port `3000` is already busy:

```bash
cd cachet/infra
MCP_PORT=3300 make up
```

The MCP service will then be reachable on `http://localhost:3300`.

### Services in the local stack
- `mcp`
  - current runnable service
  - serves health endpoints, Tool API, and MCP
- `api`
  - current runnable bootstrap for machine-to-machine registry integrations
  - serves health endpoints, a boundary descriptor at `GET /v1`, and the full management plane: skill/agent lifecycle (draft/validate/publish/promote/deprecate/certify/revoke/archive/review), policy packages, ontology packages, semantic compile, de facto terms, provenance, and the governance log
  - can optionally persist attached agent/skill artifact bytes into the registry CAS
  - validates attached agent skill references against the current registry graph
  - also serves the trust/transparency management-plane slices for trusted keys, transparency logs, witnesses, checkpoints, observations, gossip, verification, and timeline inspection
- `webapp`
  - current thin human-facing knowledge-manager admin surface
  - browses registry metadata through `service/api`
  - can register agents and skills and create skill drafts through browser forms
  - can optionally surface Semantic Turkey / VocBench companion links and project visibility
- `registry`
  - current dev container / workspace seam for registry-domain work
  - not yet a user-facing HTTP service

Current note:
- there is no Tessera companion in the default local stack yet
- see `docs/tessera.md` for the recommended optional local Docker profile direction
- an optional `tessera` profile now exists for S3-backed Tessera companion experiments
- that profile currently includes:
  - `tessera-sidecar`
  - `tessera-runtime`
  - `tessera-db`

### Plane model
- `service/registry`
  - canonical internal registry core
- `service/api`
  - canonical external management plane
- `service/mcp`
  - canonical AI-facing plane

### Env layering

#### Compose-level env
File: `infra/.env`

Used for stack-wide operator values such as:
- `MCP_PORT`

#### MCP service env
Files:
- `service/mcp/infra/.env`
- `service/mcp/infra/.env.example`

Important values:
- `HOST=0.0.0.0`
- `PORT=3000`
- `AUTH_MODE`
- `OKTA_MODE`
- `DATABASE_URL`
- `REGISTRY_OBJECTS_DIR`
- connector mode flags (`SNOWFLAKE_MODE`, `ATHENA_MODE`, `MOTHERDUCK_MODE`)

#### API service env
Files:
- `service/api/infra/.env`
- `service/api/infra/.env.example`

Important values:
- `HOST=0.0.0.0`
- `PORT=3100`
- `LOG_LEVEL`
- `DATABASE_URL=file:/workspace/data/api/agent-registry-api.db`
  - `file:`/`sqlite://` URLs use SQLite; `postgres://`/`postgresql://` URLs
    use Postgres (the production RDS URL arrives this way). When service/api
    and service/mcp share one Postgres database, both run the same migrations
    (identical IDs and schema) — the first service to boot creates the tables.
- `AUTH_MODE=api_key`
- `OKTA_MODE=mock`
- `REGISTRY_GRAPH_BACKEND=json_file`
- `REGISTRY_GRAPH_STATE_FILE=/workspace/data/registry/graph/registry-state.json`
- `REGISTRY_OBJECTS_DIR=/workspace/data/registry/objects`

Current local default note:
- the compose-backed `service/api` default is the persistent local `json_file` graph state
- the optional Fuseki/SPARQL path is still the operator-facing inspection and live-validation seam when you explicitly wire the SPARQL env vars

Optional SPARQL backend values:
- `REGISTRY_SPARQL_QUERY_URL`
- `REGISTRY_SPARQL_UPDATE_URL`
- `REGISTRY_SPARQL_USERNAME`
- `REGISTRY_SPARQL_PASSWORD`

#### Registry service env
Files:
- `service/registry/infra/.env`
- `service/registry/infra/.env.example`

Important values:
- `REGISTRY_DATA_DIR`
- `REGISTRY_OBJECTS_DIR`

#### Optional local Fuseki/SPARQL env
Files:
- `service/registry/infra/fuseki.env`
- `service/registry/infra/fuseki.env.example`

Primary values:
- `ADMIN_PASSWORD`
- `FUSEKI_DATASET_1=registry`
- `JVM_ARGS`

#### Optional Tessera sidecar env
Files:
- `service/tessera-sidecar/infra/.env`
- `service/tessera-sidecar/infra/.env.example`

Primary values:
- `TESSERA_SIDECAR_BUCKET`
- `TESSERA_SIDECAR_REGION`
- `TESSERA_SIDECAR_TILES_PREFIX`
- `TESSERA_SIDECAR_REQUESTS_PREFIX`
- optional `TESSERA_SIDECAR_AWS_ENDPOINT`
- optional `TESSERA_SIDECAR_FORCE_PATH_STYLE`
- optional `TESSERA_SIDECAR_AWS_ACCESS_KEY_ID`
- optional `TESSERA_SIDECAR_AWS_SECRET_ACCESS_KEY`

Provisioning note:
- the Terraform module/example under `infra/terraform/` now creates a shared bucket for registry artifacts plus Tessera companion data
- use the Terraform outputs `registry_artifact_env` and `tessera_sidecar_env` as the simplest copy/paste source for these env values
- or, after `terraform apply`, run `cd cachet/infra && make wire-tessera-aws` to write managed Terraform-backed env blocks into:
  - `service/api/infra/.env`
  - `service/tessera-sidecar/infra/.env`
  - `service/tessera-runtime/infra/.env`
- when you want the registry to emit real append intents during publish/certify, set these in `service/api/infra/.env` too:
  - `TESSERA_SIDECAR_URL=http://tessera-sidecar:3400`
  - `TRANSPARENCY_APPEND_LOG_ID=<your companion log id>`
- when the optional `tessera` profile is up, the sidecar can submit those append intents into the local `tessera-runtime` companion and preserve returned checkpoint metadata when available

Operator note:
- `make wire-tessera-aws` writes a managed block at the end of those env files
- rerun it after later `terraform apply` calls when the bucket, prefixes, or secret ARN change
- override the defaults when needed, for example:

```bash
cd cachet/infra
TRANSPARENCY_APPEND_LOG_ID=registry-governance-prod \
TESSERA_SIDECAR_URL=https://tessera-sidecar.internal \
make wire-tessera-aws
```

#### Webapp service env
Files:
- `service/webapp/knowledge-manager/infra/.env`
- `service/webapp/knowledge-manager/infra/.env.example`

Important values:
- `HOST=0.0.0.0`
- `PORT=3200`
- `API_ORIGIN=http://api:3100`
- `VOCBENCH_UI_URL=http://vocbench:1979/vocbench3`
- `DATABASE_URL=file:/workspace/data/webapp/knowledge-manager.db`
- `AUTH_MODE=api_key|okta|dual`
- `OKTA_MODE=mock|real`
- `OKTA_REDIRECT_URI=http://localhost:3200/session/callback`
- `OKTA_SCOPES=openid profile email`
- `SESSION_COOKIE_NAME=knowledge_manager_session`
- `SESSION_TTL_MINUTES=480`
- optional `OKTA_ISSUER`
- optional `OKTA_CLIENT_ID`
- optional `SEMANTIC_TURKEY_BASE_URL`
- optional `SEMANTIC_TURKEY_EMAIL`
- optional `SEMANTIC_TURKEY_PASSWORD`

### Shared data paths
The local stack bind-mounts `data/` into containers as `/workspace/data`.

Current important paths:
- MCP SQLite DB:
  - `data/mcp/agent-data-access.db`
- API SQLite DB:
  - `data/api/agent-registry-api.db`
- Webapp SQLite DB:
  - `data/webapp/knowledge-manager.db`
- shared persistent local graph state for API + MCP:
  - `data/registry/graph/registry-state.json`
- registry CAS objects:
  - `data/registry/objects/`
- Fuseki persistent data:
  - stored in the compose volume `registry_fuseki_data`
- optional Tessera-sidecar local data:
  - staged append-intent objects can be written into the configured S3 bucket/prefix rather than local bind-mounted storage
- Optional VocBench runtime/data:
  - `tools/vocbench/runtime/`
  - `tools/vocbench/data/`

### Common commands
Run from `infra/`:

```bash
make up
make up-tessera
make down
make logs
make logs S=mcp
make logs S=api
make logs S=tessera-sidecar
make logs S=webapp
make ps
make config
make shell-mcp
make shell-api
make shell-webapp
make shell-registry
make shell-tessera
```

### Direct service development
If you want to run the MCP service outside Docker:

```bash
cd cachet/service/mcp
npm install
npm run dev
```

If you want to run the API service outside Docker:

```bash
cd cachet/service/api
npm install
npm run dev
```

If you want to run the webapp outside Docker:

```bash
cd cachet/service/webapp/knowledge-manager
npm install
npm run dev
```

To mint a write API key for `service/api`:

```bash
cd cachet/service/api
npm run create-api-key -- --owner-label "Jane Doe"
```

Use the returned value either:
- as `Authorization: Bearer <token>` for direct API calls
- or, in local `api_key` mode only, entered once into the webapp management-session login form

Preferred internal-beta-like browser auth path:
- set both `service/api` and the webapp to `AUTH_MODE=dual` or `AUTH_MODE=okta`
- use `OKTA_MODE=mock` for a no-credentials local seam
- use `OKTA_MODE=real` with `OKTA_ISSUER` and `OKTA_CLIENT_ID` to exercise the real Okta browser redirect flow

Important boundary:
- this browser auth path currently applies to the registry-admin surface over `service/api`
- it does not yet provide unified Okta access to the Semantic Turkey / VocBench ontology-authoring companion

Current browser operator path:
1. Open `http://localhost:3200`
2. Start a management session:
   `api_key` mode: use an API key minted by `service/api`
   `okta` or `dual` with `OKTA_MODE=mock`: start the mock Okta session directly
   `okta` or `dual` with `OKTA_MODE=real`: use the Okta browser login flow
3. Register agents or skills, or open a skill detail page to create drafts and run lifecycle actions

### Fresh-install bootstrap path
For the blessed first-user walkthrough, use:
- `docs/blessed-demo-path.md`

For a clean local bootstrap focused on registry discovery/load:
1. `cd cachet/infra && make up`
2. create an API write token from `service/api`
3. seed skills first through the lifecycle endpoints:
   - draft
   - validate
   - publish
   - optionally certify
4. seed agents second through `POST /v1/agents`, attaching artifact content and existing skill refs
5. verify API reads
6. verify MCP discovery/load through `registry.*`

Current default local metadata backend:
- persistent local `json_file` graph state at `data/registry/graph/registry-state.json`
- Fuseki-backed `sparql` (dataset: `registry`) remains available as the optional inspection and live-validation backend

Current default local artifact backend:
- filesystem CAS under `data/registry/objects/`

Why this order:
- `POST /v1/agents` validates that referenced skills already exist
- `POST /v1/skills/:skillKey/drafts` is the better bootstrap entrypoint for lifecycle-aware skills than `POST /v1/skills` alone

Planned operator surface:
- `client/registry-cli`
- current commands already cover local reset/up/down, API-key creation, lifecycle-aware skill seeding, agent seeding, and MCP verification

Current blessed bootstrap command:

```bash
cd cachet/client/registry-cli
npm install
npm run dev -- bootstrap test --reset --force --up
```

Default manifest:
- `client/registry-cli/examples/demo/demo.manifest.json`

Current operator hardening:
- the CLI waits for `api`, `mcp`, and the SPARQL endpoint when the active graph lane is `sparql`
- `local reset` and `bootstrap test --reset` explicitly clear the Fuseki dataset before removing local bind-mounted state

Legacy example manifest:
- `client/registry-cli/examples/bootstrap/bootstrap.manifest.json`

Richer bootstrap pack options:
- `--profile minimal|full`
- `--skill-item-id <item-id>`
- `--agent-item-id <item-id>`
- `--dry-run`

Live Okta browser runbook:
- `service/webapp/knowledge-manager/OKTA_BROWSER_FLOW_RUNBOOK.md`

Current roadmap note:
- keep real Okta-backed ontology access deferred for now
- keep Semantic Turkey / VocBench as a separate companion runtime with its own auth/session model

Operator CLI support for the real-Okta lane:

```bash
cd cachet/client/registry-cli
npm run dev -- verify okta-config
npm run dev -- verify browser-session
npm run dev -- bootstrap test --lane okta-browser --api-token "<api-token>" --mcp-token "<mcp-token>"
```

### Validation

#### Infra validation
From `infra/`:

```bash
make config
```

#### MCP code validation
From `service/mcp/`:

```bash
npm run lint
npm run typecheck
npm test
```

#### API code validation
From `service/api/`:

```bash
npm run lint
npm run typecheck
npm test
```

This suite now includes a black-box e2e HTTP test for the public API surface.

Write-route auth/audit behavior is covered in the API integration tests.

#### Webapp code validation
From `service/webapp/knowledge-manager/`:

```bash
npm run lint
npm run typecheck
npm test
```

#### Live SPARQL e2e path
The default local metadata backend is `json_file`; Fuseki-backed `sparql` is the optional live-validation lane.

When local Fuseki is running, you can exercise the real SPARQL backend via:

```bash
cd cachet/service/api
REGISTRY_SPARQL_QUERY_URL=http://localhost:3030/registry/sparql \
REGISTRY_SPARQL_UPDATE_URL=http://localhost:3030/registry/update \
REGISTRY_SPARQL_USERNAME=admin \
REGISTRY_SPARQL_PASSWORD=admin \
npm run test:live-sparql
```

#### JSON-file fallback
If you need a local fallback without Fuseki:

```bash
REGISTRY_GRAPH_BACKEND=json_file
REGISTRY_GRAPH_STATE_FILE=/workspace/data/registry/graph/registry-state.json
```

### Auth modes
- `AUTH_MODE=api_key`
  - default local Stage 1 mode
  - use MCP/API bearer tokens generated by the relevant service's `npm run create-api-key`
- `AUTH_MODE=okta` with `OKTA_MODE=mock`
  - local Stage 2 seam
  - any bearer token is accepted in mock mode
- `AUTH_MODE=dual`
  - API key tokens starting with `agk_` use API key auth
  - other bearer tokens flow through Okta auth

### Creating an API key locally
From `service/mcp/` for MCP writes/reads that require MCP auth:

```bash
npm run create-api-key -- --owner-label "Jane Doe"
```

From `service/api/` for management-plane writes:

```bash
npm run create-api-key -- --owner-label "Jane Doe"
```

### Registry ingest today
There is still no compose one-shot ingest job yet, but the ingest CLI is now a repeatable durable bootstrap path over the same configured graph backend used by `service/mcp`.

Current workflow:

```bash
cd cachet/service/mcp
npm run registry-ingest
```

Default local durable path:
- graph state persists under `data/registry/graph/registry-state.json`
- CAS objects persist under `data/registry/objects/`
- default ingest roots are `service/mcp/agent/` and `service/mcp/skills/`

Optional flags:

```bash
npm run registry-ingest -- --agent-root ./agent --skill-root ./skills
npm run registry-ingest -- --objects-dir ../../data/registry/objects
```

Optional SPARQL bootstrap path:

```bash
cd cachet/service/mcp
REGISTRY_GRAPH_BACKEND=sparql \
REGISTRY_SPARQL_QUERY_URL=http://localhost:3030/registry/sparql \
REGISTRY_SPARQL_UPDATE_URL=http://localhost:3030/registry/update \
npm run registry-ingest
```

### Related docs
- `docs/service-map.md`
- `docs/registry-model.md`
- `infra/README.md`
- `service/mcp/README.md`
- `service/api/README.md`
