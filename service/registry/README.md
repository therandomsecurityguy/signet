## `service/registry` — Canonical Internal Registry Core

This module is the **canonical internal domain/application layer** for the registry.

It owns:
- registry semantics for agents and skills
- the certification state machine (draft/validated/rejected/published/certified/deprecated/revoked/archived) with full agent parity
- SHACL-like policy validation, ontology validation of `capability_claims`, advisory LLM validation, and the human review workflow
- semantic compiler ingestion and the de facto vocabulary store
- RFC 8785 (JCS) + RDFC-1.0 canonicalization and dual detached signatures
- PROV-O provenance modeling and the internal governance Merkle log
- time-aware platform object semantics for commits, refs, tags, workspaces, manifests, retention roots, and GC jobs
- graph + CAS orchestration
- validation and idempotency rules
- persistence abstractions over graph and artifact stores

It does **not** own:
- the public management-plane HTTP contract
- MCP protocol exposure
- direct warehouse query execution

### Current role in the system
- `service/api` is the external management plane
- `service/mcp` is the AI-facing plane
- both should consume shared registry logic rooted here

### Shared runtime expectation
For local development, `service/api` and `service/mcp` should point at the same registry graph/CAS state:
- graph metadata:
  - default: `data/registry/graph/registry-state.json` (local JSON-file backend)
  - optional: Fuseki-backed `sparql` using the `registry` dataset
- artifacts:
  - `data/registry/objects/`

### Current runtime and storage seams
Graph backends:
- in-memory graph store
- SPARQL/Jena-Fuseki graph store
- JSON-file graph store

Artifact storage:
- filesystem CAS under `data/registry/objects/`

### Local operator path
This area is usually exercised through the public planes, not run directly.

For local work:

```bash
cd cachet/infra
make up
```

Related runtime surfaces:
- `service/api` on `http://localhost:3100`
- `service/mcp` on `http://localhost:3000`
- optional local Fuseki on `http://localhost:3030`

### Where to start
- domain + storage model: `domain/together/`
- shared internal registry core: `application/`
- time-aware internal module: `application/time-aware/`
- graph adapters: `domain/together/db/graph/freeform/registry/`
- topology doc: `docs/service-map.md`
- registry model doc: `docs/registry-model.md`

### First time-aware capabilities
Current time-aware slice:
- commits
- refs
- tags
- workspaces
- artifact manifests and blobs
- retention roots
- GC jobs

The shared time-aware core now supports:
- commit lineage through parent relationships
- commit-attached manifests and blob reachability
- commit-backed temporal query operators:
  - `valid_at`
  - `transaction_as_of`
- retention-root reachability analysis across:
  - direct kept commits/blobs
  - inherited commit ancestry
  - commit-linked manifests and blobs

The current public management-plane exposure through `service/api` includes:
- read-side commit/ref/tag/workspace details
- filtered pointer queries over commit visibility
- retention-root analysis
- draft workspace creation from ref

### Current residual gaps
Still intentionally incomplete:
- ref/tag/workspace detail routes do not yet own first-class temporal metadata of their own
- manifest-only and GC-job reads are still thinner than the richer commit/retention surfaces
- retention analysis is descriptive; GC planning preview and a durable, non-destructive GC job execution seam are implemented (`POST /v1/time-aware/gc-jobs`, `POST /v1/time-aware/gc-jobs/:jobId/execute`)

### Validation today
Validation currently happens through:
- `service/api` tests
- `service/mcp` tests
- optional live SPARQL API e2e path
