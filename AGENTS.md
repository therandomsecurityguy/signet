# Signet Registry

You are working in `signet`.

## Start here

Read these first:
- `README.md`
- `docs/governance-model.md`
- `docs/quick-value-roadmap.md`
- `docs/service-map.md`
- `docs/registry-model.md`

## Canonical boundaries

- `service/registry`
  - canonical internal governance/publication core
- `service/api`
  - canonical management-plane authority
- `service/mcp`
  - canonical AI-facing read plane
- `service/webapp/knowledge-manager`
  - human-facing browser surface over `service/api`

## Deployment boundaries

- This repo publishes release-tagged artifacts only (immutable, digest-pinned
  images + `charts/signet`), to signet-owned ECR via GitHub OIDC. Releases are
  signed keyless (cosign) with GitHub build-provenance attestations and SPDX
  SBOMs attached; verify with `scripts/verify-release-signatures.sh <tag>`
  before pinning or applying a release.
- The environment repo that owns Terraform state/apply pins this repo's
  released chart and image digests; bumping a release means updating the
  pinned chart version and image digests there in one PR — merging is the
  deploy. Reusable data/registry modules (`signet-data`, `signet-registry`)
  live in this repo.
- Never deploy directly from this repo against prod; never commit secrets or seed
  secret values through Helm values/Terraform state. See
  `docs/runbooks/deploy.md` and `charts/signet/SECRETS.md`.

## Agent integration surfaces

- OpenAPI 3.1 spec + Swagger UI on `service/api` (`GET /v1/openapi.json`, `GET /v1/docs`); see `docs/api-reference.md`.
- Typed read-first SDK `@signet/registry-sdk` under `client/registry-sdk`, generated from the spec, with client-side verification helpers (`verifyEnvelopeSignatures`, `verifyDetachedSignature`, `verifyRfc6962InclusionProof`, `fetchArtifact`).
- MCP gateway `service/mcp` with read-only `registry.*` tools (including `registry.search` and `registry.verify_publication`); see `docs/mcp-onboarding.md`.
- Opt-in cognitive layer in `service/mcp` (token-context estimation + summarization).
- Operator CLI `@signet/registry-operator` under `client/registry-cli`, including `verify publication|artifact` (verify before load) and MCP artifact re-hashing.
- Distributable `signet-registry` onboarding skill under `skills/` and `.cursor/skills/signet-registry/`.

## Governance rules

- Do not make `service/mcp` a write/publication plane.
- Do not bypass `service/registry` for publication semantics.
- Keep metadata and artifact bytes separate.
- Treat trust/certification as first-class concerns.
- Be explicit about `implemented now` vs `proposed next`.

## Current trust model

Implemented now:
- lifecycle-aware skill publication
- first-class agent publication snapshots
- publication evidence fields
- authenticated/audited writes
- Fuseki-backed metadata by default
- content-addressed artifact storage
- trusted `PUBLIC_KEY`, `TRANSPARENCY_LOG`, and `TRANSPARENCY_WITNESS` trust roots
- cryptographic publication signature verification
- transparency checkpoint registration, checkpoint history, and consistency-proof validation
- witness attestations, quorum checks, checkpoint observations, and disagreement evidence
- witness gossip events and transparency timeline/provenance views
- minimal signed-note checkpoint ingestion seam
- RFC 8785 (JCS) canonical JSON for publication envelopes and governance events, with per-publication `canonicalization_algorithm` and legacy fallback
- publication envelope provenance, revocation, and supersession references
- frozen publication envelope artifacts at publish with CAS digest verification on every read (warn by default, `enforce` opt-in) and explicit live-drift reporting in publication verification
- HTTP artifact byte access on `service/api` (`GET|HEAD /v1/artifacts/{sha256}`) with `Content-Digest` and fail-closed digest verification (unverified bytes are never transported)
- MCP read gates denying revoked publications by default (`REGISTRY_READ_DENY_REVOKED`, opt out with `false`) and optionally unverified publications (`REGISTRY_READ_REQUIRE_VERIFIED`) on `registry.get_skill`/`get_agent`/`get_artifact` with explicit reason codes; verification itself is never gated
- DSSE/in-toto attestation ingestion (`POST /v1/attestations`): signatures verified over DSSE PAE bytes against trusted keys, predicate types recorded, subjects bound to publication artifacts, stored as CAS evidence linked `sg:attestedBy`, and folded into publication verification plus the read-only `registry.get_attestations` MCP tool
- certification state machine for skill and agent versions (`draft`, `validated`, `rejected`, `published`, `certified`, `deprecated`, `revoked`, `archived`)
- deterministic draft validation with `rejected` transitions and recorded validation failures
- certification bound to concrete policy and ontology versions, with optional expiry
- supersession guards (revoked snapshots are never superseded)
- full agent-version lifecycle parity with skills, including linked-skill dependency validation
- durable, non-destructive GC job execution seam
- SHACL-like policy packages as versioned CAS artifacts, with machine-readable violation reports (violation paths) linked via `sg:validatedBy`
- graph-shape validation (required properties, edges, cardinalities) layered under policy validation, gating `draft` → `validated`
- dual ontology packages (`registry_shape` and `skill_area` kinds) as versioned CAS artifacts, resolved by `ontology_version`
- ontology validation of `capability_claims` (concept binding + disjoint-combination checks) with de facto candidates recorded in validation reports
- certification bound to registered ontology packages (`ONTOLOGY_PACKAGE_NOT_FOUND` when unbound)
- PROV-O provenance: TASK records as `prov:Activity`, versions/artifacts as `prov:Entity`, `PROV_AGENT` records as `prov:Agent`, with `prov:wasDerivedFrom`, `prov:wasGeneratedBy`, `prov:used`, and `prov:wasAssociatedWith` edges written at lifecycle operations
- provenance traversal and audit replay endpoints (`GET .../versions/:v/provenance`) plus the read-only `registry.get_provenance` MCP tool
- GitHub Actions CI for service/api, service/mcp (including the cognitive layer), service/tessera-sidecar, client/registry-sdk, and client/registry-cli (typecheck, lint, tests), plus an OpenAPI spec/SDK type sync check and npm publish workflows for the SDK and CLI
- canonical governance event JSON (JCS) and digests for all lifecycle operations, stored as immutable CAS artifacts
- internal append-only Merkle log with RFC 6962 inclusion-proof generation and verifier replay (`/v1/governance-log*`)
- governance-event digests staged through the Tessera sidecar for all lifecycle operations when configured
- native RFC 6962 companion transparency log in the Tessera sidecar (S3-backed tree state, signed-note checkpoints, per-entry inclusion proofs; activated by `TESSERA_LOG_PRIVATE_KEY`, origin via `TESSERA_LOG_ORIGIN`) with registry-side reconciliation at `POST /v1/transparency-logs/reconcile`: each recorded append intent is re-fetched, its staged record digest and leaf hash re-derived, its RFC 6962 inclusion proof validated against the signed checkpoint, the checkpoint signature verified against the trusted `TESSERA_LOG_PUBLIC_KEY`, and per-intent outcomes stored as CAS evidence linked `sg:hasTransparencyReconciliation`
- canonical RDF (RDFC-1.0) projection of publication graphs with semantic digests recorded at publish and certify
- dual signatures: detached signatures over canonical JSON (operational) or canonical RDF (semantic) bytes with cross-verification
- semantic compiler ingestion: markdown frontmatter and tool-manifest parsing into normalized capability claims, interfaces, and constraints (`POST /v1/compile/skill`)
- de facto vocabulary store with human-reviewed promotion into new normative ontology versions (`/v1/de-facto-terms*`)
- advisory LLM validation layer (model-agnostic port, heuristic default, HTTP seam) emitting scorecard/prompt/confidence evidence via `sg:validatedBy`
- human review workflow: `review_evidence` artifacts via `sg:reviewedBy`, policy-driven `require_human_review` gating at publish/certify, pending-review queue (`/v1/reviews/pending`)
- policy-driven publication trust gates: `require_validation` at publish, and `require_signature`, `require_trusted_publisher`, `require_build_provenance`, `require_sbom` at certification (verified signatures owned by the publisher, and verified SLSA/SBOM attestations), each with explicit rejection codes
- verify-then-load consumer contract: client-side verification helpers in the SDK (envelope digest/signature/inclusion-proof/artifact digest), `registry-operator verify publication|artifact`, MCP artifact re-hashing in `verify mcp`, and the model write-up in `docs/supply-chain-model.md`
- single-request sign-then-publish (skills and agents): `prepare-publication` pins the candidate frozen envelope (including reserved transparency append intents); publish accepts `prepared_publication_urn` + `detached_signatures`, re-derives and fail-closes on drift (`*_PUBLISH_PREPARED_STALE`), validates each signature (trusted key, crypto, publisher binding) and freezes the signed envelope in one mutating request; the operator CLI seals seeded skills with it (falling back to envelope-attach when re-seeding already-published versions)
- threat-intel advisories: signed advisory documents (trusted-key verified over JCS bytes) map to publications by exact artifact digest first and identifiers second; `report` (default) lists the affected set, `enforce` auto-revokes revocable matches with actor `threat-intel` (citing the advisory, recording `revocation_advisory_urn`) and stores the advisory as CAS evidence; `GET /v1/advisories[/{id}]` exposes records
- keyless (sigstore) publication signatures: detached signatures may carry a bundle whose Fulcio-style certificate is verified against a configured trust policy (`KEYLESS_TRUSTED_ROOTS` PEM roots/intermediates, `KEYLESS_ALLOWED_ISSUERS`, `KEYLESS_ALLOWED_SUBJECTS` regexes; Rekor trust via `KEYLESS_REKOR_PUBLIC_KEY`/`_LOG_ID`, wired in `env.ts`/`dependencies.ts` with boot-time all-or-nothing validation) — chain to a trusted root, validity window, OIDC issuer extension (v1 and v2 profiles), SAN identity, signature digest + crypto over the signed payload; keyless signatures satisfy `require_signature`, record identity/issuer, and evaluate certificate validity against a trusted time anchor (Fulcio certs live minutes): the signed entry timestamp is verified whenever present and inclusion proofs + checkpoints additionally when present (tlog-carrying bundles fail closed without Rekor trust); integratedTime anchors certificate validity only when the SET authenticated it (`keyless.tlog.integrated_time_verified`), proof-only entries use the registry-witnessed attach time, and attach paths additionally require live-clock certificate validity; the operator CLI signs in CI (`sign keyless`: prepare -> Fulcio via OIDC -> one publish, optional certify) with optional Rekor upload

Proposed next:
- full W3C SHACL execution over RDF datasets
- normative ontologies encoded as first-class RDF/OWL vocabularies
- richer de facto ontology mining (runtime observations, corpus analysis)
- richer PROV-O coverage (JSON-LD export, canonical RDF signatures over provenance graphs)
- deeper witness-network semantics across multiple independent parties
- fuller signed-note / Tessera ecosystem compatibility

Do not overclaim future guarantees as present behavior.
