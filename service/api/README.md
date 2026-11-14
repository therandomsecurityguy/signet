## `service/api` — Registry Programmatic API

This service is the **programmatic HTTP API** for the registry.

It is intended for:
- CICD pipelines
- GitHub Actions and scanners
- CLIs
- other machine-to-machine integrations

### Current status
- full lifecycle management plane for skills and agents: draft/validate/publish/promote/deprecate/certify/revoke/archive/review
- certification state machine with deterministic draft rejection, supersession guards, and policy/ontology-bound certification
- SHACL-like policy packages, dual ontology packages, semantic compile, de facto vocabulary queue, and human review workflow
- RFC 8785 (JCS) + RDFC-1.0 canonicalization with dual detached signatures and verification endpoints
- PROV-O provenance traversal and audit replay, plus the internal governance Merkle log with inclusion proofs and replay
- durable, non-destructive GC job execution seam
- API writes default to a persistent local graph adapter; SPARQL-backed graph backend is the optional lane
- write routes require authentication and are audited
- black-box e2e coverage exists for the public API surface
- local infra is wired; health endpoints are live; service boundaries are documented through `GET /v1`

### Useful test lanes

Run all of the following from:

```bash
cd cachet/service/api
```

Persistent local transparency sample graph:

```bash
npm test -- tests/e2e/transparency-blackbox.test.ts
```

This lane seeds a realistic transparency sample graph over the real HTTP API, restarts the server against the same persistent `json_file` graph/object state, and verifies that the transparency log, verification, and timeline surfaces still read back correctly.

First-class operator path for the same sample graph:

```bash
cd cachet/client/registry-cli
npm run dev -- seed transparency-sample --api-token "<api-token>"
```

This uses the operator CLI to seed the same trust-story shape through `service/api` and prints the resulting log, verification, and timeline payloads for human inspection.

Optional smaller proof-oriented report:

```bash
cd cachet/client/registry-cli
npm run dev -- seed transparency-sample --api-token "<api-token>" --human-proof-report
```

Happy-path markdown skill trust proof:

```bash
npx vitest run tests/unit/skill-lifecycle.test.ts -t "shows a happy-path trust story for a markdown skill publication" --reporter=verbose
```

This lane proves that a markdown-backed skill publication can be trusted because:
- the publication envelope still matches the signed state
- the detached signature resolves a trusted public key
- cryptographic verification passes
- the transparency proof validates against the trusted transparency log/checkpoint model

Tamper-evident markdown skill trust failure:

```bash
npx vitest run tests/unit/skill-lifecycle.test.ts -t "shows tamper-evident failure for a signed markdown skill publication after state changes" --reporter=verbose
```

This lane proves the unhappy path by signing a published markdown-backed skill and then mutating the publication state afterward. The verification output then shows:
- `verification_status: signature_mismatch`
- `transparency_verification_status: mismatch`
- preserved signer/key/log/proof metadata so a human can still inspect who signed what, when, and through which trust path

Live Fuseki/SPARQL transparency sample graph:

```bash
ENABLE_LIVE_SPARQL_E2E=1 \
REGISTRY_SPARQL_QUERY_URL=http://127.0.0.1:3030/registry/sparql \
REGISTRY_SPARQL_UPDATE_URL=http://127.0.0.1:3030/registry/update \
REGISTRY_SPARQL_USERNAME=admin \
REGISTRY_SPARQL_PASSWORD=admin \
npx vitest run tests/e2e/api-sparql-live.test.ts --reporter=verbose
```

This env-gated lane reuses the realistic transparency sample graph against a real Fuseki/SPARQL backend instead of the local `json_file` graph backend.

### Get value fast

```bash
cd cachet/service/api
npm install
npm run dev
```

Health check:

```bash
curl -s http://localhost:3100/healthz
```

Create a write API key:

```bash
cd cachet/service/api
npm run create-api-key -- --owner-label "Jane Doe"
```

Use it as:

```bash
Authorization: Bearer <token>
```

### What this service owns
- future CRUD-style registry operations
- machine-oriented endpoints over registry entities and workflows
- programmatic integration surface outside MCP harness use cases

### What this service does not own
- MCP transport and agent-tool protocol behavior
- warehouse query execution
- registry graph/CAS persistence internals

### Adjacent services
- `service/mcp`
  - tool-based agent access and MCP exposure
- `service/registry`
  - domain model, graph metadata, artifact storage, and ingestion seams

### Endpoints today
- `GET /healthz`
- `GET /readyz`
- `GET /v1`
- `GET /v1/openapi.json` (generated OpenAPI 3.1 spec)
- `GET /v1/docs` (Swagger UI)
- `GET /v1/agents`
- `GET /v1/agents/:agentKey`
- `GET /v1/agents/:agentKey/versions`
- `GET /v1/agents/:agentKey/versions/:version/publication-envelope`
- `GET /v1/agents/:agentKey/versions/:version/verification`
- `GET /v1/agents/:agentKey/active`
- `POST /v1/agents/:agentKey/versions/:version/signatures`
- `GET /v1/public-keys`
- `GET /v1/public-keys/:keyRef`
- `POST /v1/public-keys`
- `POST /v1/public-keys/:keyRef/revoke`
- `GET /v1/transparency-logs`
- `GET /v1/transparency-logs/:logId`
- `GET /v1/transparency-logs/:logId/verification`
- `POST /v1/transparency-logs`
- `POST /v1/transparency-logs/:logId/witnesses`
- `POST /v1/transparency-logs/:logId/checkpoints`
- `POST /v1/transparency-logs/:logId/observations`
- `POST /v1/agents`
- `GET /v1/session`
- `GET /v1/skills`
- `GET /v1/skills/:skillKey`
- `POST /v1/skills`
- `GET /v1/skills/:skillKey/versions`
- `GET /v1/skills/:skillKey/versions/:version`
- `GET /v1/skills/:skillKey/versions/:version/publication-envelope`
- `GET /v1/skills/:skillKey/versions/:version/verification`
- `GET /v1/skills/:skillKey/active`
- `POST /v1/skills/:skillKey/drafts`
- `POST /v1/skills/:skillKey/versions/:version/signatures`
- `POST /v1/skills/:skillKey/versions/:version/validate`
- `POST /v1/skills/:skillKey/versions/:version/publish`
- `POST /v1/skills/:skillKey/versions/:version/promote`
- `POST /v1/skills/:skillKey/versions/:version/deprecate`
- `POST /v1/skills/:skillKey/versions/:version/certify`
- `POST /v1/skills/:skillKey/versions/:version/revoke`
- `POST /v1/skills/:skillKey/versions/:version/archive`
- `POST /v1/skills/:skillKey/versions/:version/review`
- `GET /v1/skills/:skillKey/versions/:version/provenance`
- `GET /v1/agents/:agentKey/versions/:version/provenance`
- `POST /v1/agents/:agentKey/drafts`
- `POST /v1/agents/:agentKey/versions/:version/validate`
- `POST /v1/agents/:agentKey/versions/:version/publish`
- `POST /v1/agents/:agentKey/versions/:version/promote`
- `POST /v1/agents/:agentKey/versions/:version/deprecate`
- `POST /v1/agents/:agentKey/versions/:version/certify`
- `POST /v1/agents/:agentKey/versions/:version/revoke`
- `POST /v1/agents/:agentKey/versions/:version/archive`
- `POST /v1/agents/:agentKey/versions/:version/review`
- `GET /v1/policy-packages`
- `GET /v1/policy-packages/:policyVersion`
- `POST /v1/policy-packages`
- `GET /v1/ontology-packages`
- `GET /v1/ontology-packages/:ontologyVersion`
- `POST /v1/ontology-packages`
- `POST /v1/compile/skill`
- `GET /v1/de-facto-terms`
- `POST /v1/de-facto-terms/:term/review`
- `GET /v1/reviews/pending`
- `GET /v1/governance-log`
- `GET /v1/governance-log/proofs/:leafIndex`
- `GET /v1/governance-log/replay`
- `POST /v1/time-aware/gc-jobs`
- `POST /v1/time-aware/gc-jobs/:jobId/execute`
- `GET /v1/time-aware/commits`
- `GET /v1/time-aware/commits/:commitId`
- `GET /v1/time-aware/refs`
- `GET /v1/time-aware/refs/:refName`
- `GET /v1/time-aware/tags`
- `GET /v1/time-aware/tags/:tagName`
- `GET /v1/time-aware/workspaces`
- `GET /v1/time-aware/workspaces/:workspaceId`
- `GET /v1/time-aware/manifests`
- `GET /v1/time-aware/retention-roots`
- `GET /v1/time-aware/retention-roots/:rootId/analysis`
- `GET /v1/time-aware/retention-roots/:rootId/gc-plan`
- `GET /v1/time-aware/gc-jobs`
- `POST /v1/time-aware/refs/:refName/workspaces/:workspaceId/draft`

### Current write trust boundary
Protected write routes today:
- `POST /v1/agents`
- `POST /v1/agents/:agentKey/versions/:version/signatures`
- `POST /v1/public-keys`
- `POST /v1/public-keys/:keyRef/revoke`
- `POST /v1/skills`
- `POST /v1/transparency-logs`
- `POST /v1/transparency-logs/:logId/witnesses`
- `POST /v1/transparency-logs/:logId/checkpoints`
- `POST /v1/transparency-logs/:logId/observations`
- `POST /v1/skills/:skillKey/drafts`
- `POST /v1/skills/:skillKey/versions/:version/signatures`
- `POST /v1/skills/:skillKey/versions/:version/validate`
- `POST /v1/skills/:skillKey/versions/:version/publish`
- `POST /v1/skills/:skillKey/versions/:version/promote`
- `POST /v1/skills/:skillKey/versions/:version/deprecate`
- `POST /v1/skills/:skillKey/versions/:version/certify`
- `POST /v1/skills/:skillKey/versions/:version/revoke`
- `POST /v1/skills/:skillKey/versions/:version/archive`
- `POST /v1/skills/:skillKey/versions/:version/review`
- `POST /v1/agents/:agentKey/drafts`
- `POST /v1/agents/:agentKey/versions/:version/validate`
- `POST /v1/agents/:agentKey/versions/:version/publish`
- `POST /v1/agents/:agentKey/versions/:version/promote`
- `POST /v1/agents/:agentKey/versions/:version/deprecate`
- `POST /v1/agents/:agentKey/versions/:version/certify`
- `POST /v1/agents/:agentKey/versions/:version/revoke`
- `POST /v1/agents/:agentKey/versions/:version/archive`
- `POST /v1/agents/:agentKey/versions/:version/review`
- `POST /v1/policy-packages`
- `POST /v1/ontology-packages`
- `POST /v1/compile/skill`
- `POST /v1/de-facto-terms/:term/review`
- `POST /v1/time-aware/gc-jobs`
- `POST /v1/time-aware/gc-jobs/:jobId/execute`
- `POST /v1/time-aware/refs/:refName/workspaces/:workspaceId/draft`

Current guarantees:
- missing/invalid bearer tokens are denied and audited
- successful writes are audited
- validation/conflict/not-found write failures are audited
- nested lifecycle and time-aware write routes are protected by the same write-auth middleware as top-level create routes

Current auth modes:
- `AUTH_MODE=api_key`
- `AUTH_MODE=okta`
- `AUTH_MODE=dual`

Session validation endpoint:
- `GET /v1/session`
- requires the same bearer token that would be used on protected writes
- returns the resolved principal plus the current API auth mode
- used by `service/webapp/knowledge-manager` to align browser sessions to the real `service/api` auth boundary

### Current `agents` slice
This first slice is intentionally narrow:
- list agents
- get a single agent by `agent_key`
- create agent metadata in the persistent local graph adapter by default
- optionally attach an artifact and persist it into the registry CAS
- optionally attach skill references by `skill_key` or `skill_urn`
- validate that referenced skills already exist
- treat repeated identical create requests as idempotent

Current create payload:

```json
{
  "agent_key": "cursor:cyborg",
  "harness_name": "cursor",
  "display_name": "Cyborg",
  "description": "A programmatic registry agent.",
  "source_path": "service/mcp/agent/cyborg/cursor/AGENTS.md",
  "artifact": {
    "content": "# Agent file\\n\\nhello",
    "encoding": "utf8",
    "media_type": "text/markdown",
    "original_path": "service/mcp/agent/cyborg/cursor/AGENTS.md"
  },
  "skill_refs": [
    { "skill_key": "skill:repo-move-reference-repair" },
    { "skill_urn": "urn:tg:skill:skill:local-infra-bootstrap" }
  ]
}
```

Current limitations:
- graph storage now defaults to a shared persistent local JSON graph file under `data/registry/graph/registry-state.json`
- attached artifact bytes are persisted into the filesystem CAS under `data/registry/objects/`
- attached skills are currently graph-link semantics only; this slice does not create skill artifacts
- write auth and audit are in place; fine-grained authorization policy is still limited
- no multipart/binary upload flow yet; current artifact attachment is request-body content based

Bootstrap recommendation:
- seed skills first
- then create agents with `skill_refs`
- agent create returns `SKILL_NOT_FOUND` when referenced skills do not already exist
- the current operator-friendly wrapper for this flow now lives under `client/registry-cli`

### Current `skills` slice
This mirrored slice supports:
- list skills
- get a single skill by `skill_key`
- create skill metadata in the persistent local graph adapter
- optionally attach a skill artifact and persist it into the registry CAS
- treat repeated identical create requests as idempotent

Bootstrap recommendation:
- use `POST /v1/skills/:skillKey/drafts` for lifecycle-aware first-use seeding
- then move the created version through `validate`, `publish`, and optional `certify`
- use `POST /v1/skills` only when you explicitly want logical skill metadata without an initial version transition
- the operator CLI now supports richer bootstrap packs with profile-based selection on top of this API surface

### Lifecycle management-plane slice
The full lifecycle management plane is implemented for skills and agents with parity.

Current operations:
- create draft version
- validate version (deterministic graph-shape + policy + ontology checks; failures transition to `rejected`)
- publish version
- promote version to active
- deprecate version
- certify version (bound to policy and ontology versions, optional expiry)
- revoke version
- archive version
- review version (human approve/reject, policy-gated)
- resolve active version

Current lifecycle backing concepts:
- `SKILL_VERSION` / `AGENT_VERSION`
- `TASK`
- `PROV_AGENT` and PROV-O provenance edges
- optional lineage metadata on draft creation
- `capability_claims` and ontology binding on drafts

### Time-aware management-plane slice
The first time-aware management-plane slice is now implemented.

Current scope:
- list commits
- get commit details with parents, children, refs, tags, workspaces, manifests, and blobs
- list refs
- get ref details and filter refs by target commit
- list tags
- get tag details and filter tags by target commit
- list workspaces
- get workspace details and filter workspaces by base commit
- list artifact manifests
- list retention roots
- analyze a retention root across direct and inherited commit retention plus commit-linked manifests/blobs
- preview a read-only GC plan from a retention root
- list GC jobs
- create a draft workspace from a ref

Temporal query operators now supported on commit-backed time-aware reads:
- `valid_at=<iso-datetime>`
- `transaction_as_of=<iso-datetime>`

Current behavior:
- `GET /v1/time-aware/commits` supports temporal filtering
- `GET /v1/time-aware/commits/:commitId` can resolve commit details as of a transaction/valid-time query and returns `404` when the commit is not visible under that query
- `GET /v1/time-aware/refs`, `GET /v1/time-aware/tags`, and `GET /v1/time-aware/workspaces` apply temporal filtering based on the visibility of their target/base commit
- `GET /v1/time-aware/retention-roots/:rootId/analysis` applies temporal filtering before ancestry/manifests/blob reachability are expanded
- `GET /v1/time-aware/retention-roots/:rootId/gc-plan` derives protected sets, global candidate manifests/blobs, and blockers from the current retention graph under the same temporal query

Current time-aware backing concepts:
- `COMMIT`
- `REF`
- `TAG`
- `WORKSPACE`
- `ARTIFACT_BLOB`
- `ARTIFACT_MANIFEST`
- `RETENTION_ROOT`
- `GC_JOB`

Draft workspace example:

```bash
curl -s -X POST "http://localhost:3100/v1/time-aware/refs/main/workspaces/team-alpha/draft" \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer <token>" \
  -d '{
    "owner": "alpha",
    "expires_at": "2026-12-31T00:00:00Z",
    "promotion_path": "main>approved"
  }'
```

Draft creation example:

```bash
curl -s -X POST "http://localhost:3100/v1/skills/skill:example/drafts" \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer <token>" \
  -d '{
    "author": "jane",
    "commit_sha": "abc123",
    "git_tag": "v0.1.0-rc1",
    "artifact_signature": "sig-1",
    "artifact": {
      "content": "# Skill file\n\nhello",
      "encoding": "utf8",
      "media_type": "text/markdown",
      "original_path": "skills/example.md"
    },
    "lineage": {
      "upstream_skill_version_urns": [],
      "openlineage": {
        "job_namespace": "tg",
        "job_name": "skill-build",
        "run_id": "run-1"
      }
    }
  }'
```

Current skill create payload:

```json
{
  "skill_key": "skill:example-skill",
  "display_name": "Example Skill",
  "description": "A programmatic registry skill.",
  "source_path": "skills/example-skill.md",
  "artifact": {
    "content": "# Skill file\\n\\nhello",
    "encoding": "utf8",
    "media_type": "text/markdown",
    "original_path": "skills/example-skill.md"
  }
}
```

### Local operator path

```bash
cd cachet/service/api
npm install
npm run dev
```

Important env defaults:
- `DATABASE_URL=file:./var/agent-registry-api.db`
- `AUTH_MODE=api_key`
- `OKTA_MODE=mock`
- `REGISTRY_GRAPH_BACKEND=json_file`
- `REGISTRY_GRAPH_STATE_FILE=../../data/registry/graph/registry-state.json`
- `REGISTRY_ARTIFACT_BACKEND=fs`
- `REGISTRY_OBJECTS_DIR=../../data/registry/objects`

Optional SPARQL lane (inspection and live validation):
- `REGISTRY_GRAPH_BACKEND=sparql`
- `REGISTRY_SPARQL_QUERY_URL=http://localhost:3030/registry/sparql`
- `REGISTRY_SPARQL_UPDATE_URL=http://localhost:3030/registry/update`
- `REGISTRY_SPARQL_USERNAME=admin`
- `REGISTRY_SPARQL_PASSWORD=admin`

Optional advisory LLM validator seam:
- `LLM_VALIDATOR_URL=<model endpoint>` (falls back to the heuristic validator)

Optional S3 artifact seam:
- `REGISTRY_ARTIFACT_BACKEND=s3`
- `REGISTRY_S3_BUCKET=agents-registry-artifacts`
- `REGISTRY_S3_PREFIX=cachet/dev`
- `REGISTRY_S3_REGION=us-west-2`
- optional `REGISTRY_S3_ENDPOINT`, `REGISTRY_S3_FORCE_PATH_STYLE`, `REGISTRY_S3_ACCESS_KEY_ID`, `REGISTRY_S3_SECRET_ACCESS_KEY`
- the Terraform module/example under `infra/terraform/` now outputs a copy/paste `registry_artifact_env` block for this
- if you also run the optional `tessera-sidecar`, use the same bucket with separate Tessera prefixes rather than a second ad hoc bucket

Optional real append-intent bridge to the sidecar:
- `TESSERA_SIDECAR_URL=http://tessera-sidecar:3400`
- `TRANSPARENCY_APPEND_LOG_ID=registry-governance-dev`

When these are set, publish/certify flows can stage real publication/governance append intents through the sidecar and preserve the returned S3 reference in the registry evidence model.
When the sidecar is connected to the optional `tessera-runtime`, the publication verification model can also surface:
- Tessera entry index
- checkpoint URL
- checkpoint tree size
- checkpoint root hash
- checkpoint-note SHA256
- checkpoint artifact URN when the checkpoint note is fetched and stored in the registry CAS

Human-facing verification summary now also includes:
- `publication_append_intent`
- `governance_append_intents`
- `append_intent_verification_status`

This lets a human see not only that a publication was sent to the sidecar/runtime, but whether it was actually committed by an observed checkpoint.

### Create a write API key locally

```bash
cd cachet/service/api
npm run create-api-key -- --owner-label "Jane Doe"
```

Use the returned token as:

```bash
Authorization: Bearer <token>
```

### Run with Docker Compose

```bash
cd cachet/infra
make up
```

API will be available at:
- `http://localhost:3100`

If port `3100` is already in use:

```bash
cd cachet/infra
API_PORT=3200 make up
```

### Validate

```bash
npm run lint
npm run typecheck
npm test
```

The current API test suite includes:
- unit tests
- route-level tests
- black-box e2e HTTP test against the real API server

Optional live SPARQL e2e path:

```bash
REGISTRY_SPARQL_QUERY_URL=http://localhost:3030/registry/sparql \
REGISTRY_SPARQL_UPDATE_URL=http://localhost:3030/registry/update \
REGISTRY_SPARQL_USERNAME=admin \
REGISTRY_SPARQL_PASSWORD=admin \
npm run test:live-sparql
```

### Governance note
This service is the canonical write/publication authority for the registry.

Current governance baseline:
- authenticated and audited writes
- lifecycle-aware skill publication
- first-class agent publication snapshots
- publication evidence fields surfaced from the shared registry core
- active publication reads for both agents and skills

SHACL-like policy packages, PROV-O provenance, and dual canonical signatures are implemented here by consuming `service/registry` — not by bypassing it. Future governance layers should follow the same rule.

### Related docs
- `docs/governance-model.md`
- `docs/local-development.md`
- `docs/service-map.md`
- `service/api/AGENTS.md`
