## Tessera In Signet

### What Tessera is

Tessera is a Go library for building tile-based transparency logs (`tlog-tiles`). It is positioned by the Transparency.dev / TrustFabric team as the logical successor to Trillian v1 for new transparency-log deployments.

Important properties called out by the Tessera project:
- library-first, not a microservice stack
- native `tlog-tiles` read path
- support for AWS, GCP, and POSIX storage drivers
- append, sequencing, integration, publishing, and witness support
- lower operational complexity than older multi-service transparency stacks

Useful primary references:
- [Introducing Trillian Tessera](https://blog.transparency.dev/introducing-trillian-tessera)
- [Tessera repository](https://github.com/transparency-dev/tessera)

### Why it matters to this project

Signet already has a real transparency model:
- trusted public keys
- transparency log identities
- transparency witness identities
- checkpoint history
- consistency proofs
- witness attestations
- observations
- disagreement and gossip evidence
- publication verification tied to transparency proofs

Today, most of that logic is modeled and validated inside the registry core and the API.

Tessera matters because it offers a plausible next operational backend for the append-only transparency side of that model, especially when we want:
- a real external append target for governance-event digests
- published checkpoints with witness countersignatures
- a concrete tiles-based transparency backend instead of only internal evidence simulation

### What Tessera is not for here

Tessera is not a replacement for:
- the registry metadata graph
- Fuseki/SPARQL metadata storage
- the management-plane API
- the canonical trust/governance read models in `service/registry`

In this repo, Tessera should be treated as a **transparency backend companion**, not the new source of truth for all registry state.

The canonical split should remain:
- `service/registry`
  - trust/governance semantics
  - graph/CAS modeling
  - publication and verification logic
- Tessera
  - append-only transparency-log backend
  - checkpoints / witness publication path
  - tiles-native log serving

### Tessera concepts that matter for our design

#### 1. Sequencing

Entries are durably assigned indices before they are fully integrated into the published tree.

Why this matters here:
- we should not assume "append request succeeded" means "final checkpoint published"
- registry evidence models may eventually need to distinguish:
  - requested append
  - sequenced entry
  - integrated entry
  - published checkpoint

#### 2. Integration

Integrated entries become part of the Merkle tree state.

Why this matters here:
- inclusion-proof references should map to a real integrated tree state, not only an abstract proof blob

#### 3. Publishing

Tessera publishes checkpoints and can collect witness countersignatures before considering a checkpoint public.

Why this matters here:
- our current witness/quorum model fits naturally with Tessera’s checkpoint publishing story
- the current registry witness model is a good conceptual bridge to a real Tessera witness-policy setup later

#### 4. Witnessing

Tessera supports witnesses and witness policies as first-class concepts.

Why this matters here:
- the current registry disagreement / gossip / provenance work is not wasted
- it can become the higher-level interpretation layer over a real witness-backed log backend

#### 5. POSIX driver

Tessera explicitly supports a POSIX filesystem backend.

Why this matters here:
- this is the best low-friction local development option for this repo
- it avoids forcing cloud drivers into local laptop/dev-container workflows

### Current status in Signet

Implemented now:
- minimal signed-note checkpoint ingestion seam
- richer signed-note parsing
- compatibility-preserving normalization into current checkpoint verification
- realistic transparency sample graph over HTTP
- persistent `json_file` proof lane
- live Fuseki/SPARQL proof lane for the registry metadata side
- Terraform for a locked-down shared S3 bucket seam for registry artifacts and Tessera companion data
- an optional `tessera-sidecar` Docker companion that stages append-intent objects into S3 for future Tessera-facing workflows
- the first real registry-to-sidecar append flow for publication envelopes and governance artifacts during publish/certify
- an optional `tessera-runtime` companion that can accept those append intents and return entry plus checkpoint metadata
- Aurora MySQL + Secrets Manager Terraform for the Tessera AWS backend state, plus runtime support for resolving DB config indirectly from `TESSERA_DB_SECRET_ARN`

Implemented since:
- canonical governance event JSON (RFC 8785 JCS) and SHA-256 digests for every lifecycle operation (create_draft, validate, publish, certify, promote/supersede, deprecate, revoke, archive), stored as immutable CAS artifacts
- an internal append-only Merkle log (`urn:sg:governance-log:registry`) over those events with RFC 6962 inclusion-proof generation (`GET /v1/governance-log/proofs/:leafIndex`), log state (`GET /v1/governance-log`), and verifier replay (`GET /v1/governance-log/replay`) that recomputes the root from the event stream
- governance-event digests staged through the sidecar for all lifecycle operations when the sidecar is configured, anchoring the internal log to the external transparency backend

Not implemented yet:
- no reconciliation between Tessera tiles/checkpoints and registry evidence references beyond the current append-intent verification fields
- no first-class external Tessera witness policy integration

### AWS deployment shape now supported

The repo now has a minimal but credible AWS deployment seam for the current companion architecture:
- one shared S3 bucket for registry CAS objects plus Tessera tiles/checkpoints and append-intent staging
- one Aurora MySQL Serverless v2 cluster for the Tessera runtime state
- one Secrets Manager secret containing the runtime DB connection payload

The intended wiring is:
- `service/api`
  - uses the registry artifact S3 env block
- `service/tessera-sidecar`
  - uses the bucket + prefix env block
- `service/tessera-runtime`
  - uses `TESSERA_BUCKET`
  - uses `TESSERA_AWS_REGION`
  - uses `TESSERA_DB_SECRET_ARN`

The most useful operator entrypoint is now:
- `infra/terraform/examples/dev/registry-tessera-aws-backend`

That example gives humans two indirection choices:
- remote-state consume the outputs directly
- copy/paste the emitted env blocks while keeping the DB credentials hidden behind the secret ARN and the bucket layout optionally hidden behind SSM parameter names

Inside this repo, the next real deployment step is now wired to the compose-backed operator path:
- run `terraform apply` in `infra/terraform/examples/dev/registry-tessera-aws-backend`
- then run `cd signet/infra && make wire-tessera-aws`

That command writes managed Terraform-backed env overrides into:
- `service/api/infra/.env`
- `service/tessera-sidecar/infra/.env`
- `service/tessera-runtime/infra/.env`

So the current local/operator runtime path can consume the AWS bucket/prefix/secret outputs without manual editing.

### Recommended local dev direction

#### Short answer

For local dev, start with an **optional Docker companion** that uses an S3-backed sidecar seam first, then graduate to a real Tessera personality once the narrow append/reference flow is proven.

#### Why S3-first now

The repo already supports S3-backed artifact storage, and the immediate goal has shifted from "prove a local Tessera process exists" to "move registry artifacts off local disk and reserve a real bucket/prefix layout for future Tessera work".

That makes an S3-first companion path the better next move because it:
- aligns with the existing `S3CasArtifactStore`
- avoids investing in a POSIX-only local layout we already know we do not want as the main direction
- gives us a real shared storage seam for both registry artifacts and future Tessera tiles/append objects
- keeps the future Tessera personality work focused on append/checkpoint semantics rather than redoing storage decisions

#### What to avoid first

Do **not** start by:
- introducing a new canonical `service/tessera` authority for registry logic
- forcing a cloud driver into local dev before we prove the personality/API fit
- trying to replace Fuseki with Tessera

### Proposed dev plan

#### Phase 0. Keep the current registry trust story as the truth layer

Continue using:
- `service/registry`
- `service/api`
- current transparency sample graph

This remains the baseline proof and regression layer.

#### Phase 1. Add an optional local Tessera companion profile

Recommended shape:
- Docker compose profile, not always-on default service
- S3-backed companion sidecar first
- one exposed HTTP port for sidecar health/config/append-intent staging
- shared bucket/prefixes reserved for:
  - registry artifact CAS
  - future Tessera tiles/checkpoints
  - append-intent/request objects

Why optional:
- most developers do not need Tessera running for ordinary registry work
- transparency-backend experiments should not make the default stack heavier

#### Phase 2. Add a tiny bridge, not a new authority

The first integration should be narrow:
- append or stage a canonical governance or publication digest into the Tessera-sidecar/S3 seam
- reserve the prefix and object shape that a future Tessera personality can consume
- later read back checkpoint/proof references
- store those references in the registry evidence model

This first real bridge now exists in the repo:
- publish/certify flows can call the sidecar
- the sidecar returns an S3 reference for the append-intent object
- the sidecar can also submit into the runtime and return entry/checkpoint metadata
- those references are preserved on publication envelopes and governance artifacts

Publication verification can now expose a stronger statement than only:
- "submitted to Tessera"

It can now also expose:
- "committed by checkpoint X"

through returned checkpoint URL / tree size / root hash / checkpoint-note digest metadata when the runtime observes a published checkpoint for the submitted entry.

The stronger proof object now includes:
- a checkpoint artifact stored in the registry CAS when the checkpoint note can be fetched
- a publication-level append-intent verification summary
- governance-artifact append-intent verification summaries

That gives us a much more useful human trust story than only a raw sidecar response.

This should be treated as a companion integration path, not a takeover of verification semantics.

#### Phase 3. Add focused local proofs

Once Phase 2 exists, add tests that prove:
- registry event digest appended to Tessera
- checkpoint/proof references stored in registry artifacts
- registry verification surfaces can explain the linkage

#### Phase 4. Only then consider broader productization

After the companion path is stable:
- decide whether to keep Tessera as a tool/companion process
- or promote it into a more formal local service profile with clearer operator commands

### Suggested compose shape

Implemented now:
- add a `tessera` profile under `infra/docker-compose.yml`
- use `service/tessera-sidecar`
- expose a host port only for local dev and tests
- point it at a shared S3 bucket/prefix layout

Still intentionally next:
- replace or complement the sidecar seam with a real Tessera personality/runtime
- keep it separated from the current `registry-graph` Fuseki container

Conceptually:
- `registry-graph`
  - metadata graph inspection and persistence seam
- `tessera`
  - append-only transparency backend companion

### Recommended next implementation steps

1. Provision the shared S3 bucket/prefix layout.
2. Move the registry artifact backend to S3 where desired.
3. Use the optional `tessera-sidecar` profile to validate bucket wiring and append-intent staging.
4. Append a narrow class of registry governance-event digests into the sidecar seam first.
5. Add a real Tessera personality/runtime only after the S3-backed integration contract is stable.

### Guidance for future agents

When integrating Tessera:
- keep `service/registry` as the canonical governance core
- keep `service/api` as the write authority
- treat Tessera as a companion append-only backend
- prefer the shared S3 bucket seam before adding a full Tessera runtime
- do not over-rotate into a separate platform before the narrow digest-append path is proven
