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
  images + `charts/signet`), to GHCR under `ghcr.io/<owner>/signet/…` with the
  release workflow's `GITHUB_TOKEN` — no cloud account required (the
  `signet-registry` Terraform module remains available for ECR-based
  deployments). Releases are
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
- Typed read-first SDK `@signet-registry/sdk` under `client/registry-sdk`, generated from the spec, with client-side verification helpers (`verifyEnvelopeSignatures`, `verifyDetachedSignature`, `verifyRfc6962InclusionProof`, `fetchArtifact`).
- MCP gateway `service/mcp` with read-only `registry.*` tools (including `registry.search` and `registry.verify_publication`); see `docs/mcp-onboarding.md`.
- Opt-in cognitive layer in `service/mcp` (token-context estimation + summarization).
- Operator CLI `@signet-registry/operator` under `client/registry-cli`, including `verify publication|artifact` (verify before load) and MCP artifact re-hashing.
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
- witness attestations, quorum checks, checkpoint observations, and disagreement evidence; waxing-style witness cosignatures on signed notes are verified against attached witnesses (name-bound spec hint for Ed25519 keys, SPKI hint for legacy PEMs) — invalid or ambiguous matches fail closed (`CHECKPOINT_COSIGNATURE_INVALID`) and quorum counts DISTINCT witnesses across attestations and cosignatures (one witness can never satisfy a quorum alone; details expose `valid_witness_count`)
- witness gossip events and transparency timeline/provenance views
- minimal signed-note checkpoint ingestion seam that verifies BOTH key-identity conventions: the legacy SPKI-hint format and the transparency-dev spec note format (Ed25519: key hash = bigendian32(SHA256(origin + "\n" + 0x01||pubkey))[:4], pure-Ed25519 note signatures, `<name>+<hash8hex>+<base64>` verifier keys) — signed-note submissions for Ed25519 trusted keys must bind to the name-bound spec hint (fail-closed `CHECKPOINT_NOTE_KEY_HINT_MISMATCH`), reconciliation accepts `TESSERA_LOG_NOTE_VERIFIER` as the spec alternative to `TESSERA_LOG_PUBLIC_KEY` (mutually exclusive), and a fixture generated with the real x/mod note library is verified by both the Go runtime tests and the registry's TypeScript tests; the native sidecar emits spec notes in note mode (`TESSERA_LOG_NOTE_KEY`, byte-identical fixture-verified Ed25519 signing, mutually exclusive with the legacy PEM, key name pinned to `TESSERA_LOG_ORIGIN`)
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
- policy packages as versioned CAS artifacts in two authoring formats: legacy JSON shape documents (translated to SHACL before execution, byte-identical gating behavior) and authored W3C SHACL Turtle (`shapes_format: "shacl-turtle"`; registration-time conventions: `sh:targetClass` over `urn:sg:entity-type:` IRIs, simple `urn:sg:property:`/`urn:sg:predicate:` paths, RE2-validated `sh:pattern`), with machine-readable violation reports linked via `sg:validatedBy`
- W3C SHACL Core execution (Zazuko `rdf-validate-shacl`, in-process behind a swappable port) for the built-in graph shape (authored Turtle) and policy shapes, gating `draft` → `validated`: focus-scoped `sh:targetNode` targeting (edge targets are never validated incidentally), RE2-owned `sh:pattern` (linear-time, ReDoS-safe; patterns are stripped before engine execution), `datatype: "number"` → `sh:or(integer, double)` with the result component normalized back, per-constraint Violation/Warning/Info severities with Warning/Info evidence-only, deterministic violation ordering, and a 72-case legacy-parity suite; validation reports record `validator: shacl-v1`, the engine id, and per-layer `shapes_format`/`shapes_sha256`
- SPARQL-capable hybrid execution (`shacl-engine` + its SPARQL plugin, plugin ALWAYS loaded — without it SPARQL features would be silently ignored): authored policies may use node-shape `sh:sparql` constraints (spec-aligned `$this` focus binding, `?path`/`?value` carried into results, `{$var}` message interpolation, `sh:prefixes`/`sh:declare` resolution) and SPARQL-based targets (`sh:target` + `sh:select`); engine choice is per shapes document (core-only stays on `rdf-validate-shacl`; SHACL-AF routes to the pyshacl runtime) and SPARQL-target results are focus-filtered so edge targets can never be validated incidentally; registration refuses property-shape `sh:sparql` (engine semantics differ from the W3C prebinding model), `REGEX(` inside SPARQL (the RE2-owned `sh:pattern` remains the regex path), and `sh:js`/`sh:expression` (not executed — a governance gate must never pass unexecuted); report policy layers record the engine that ran (`shacl-engine@1.1.3+sparql`, or `pyshacl@0.40.2+shacl-runtime` for SHACL-AF layers)
- SHACL-AF execution via the optional pyshacl runtime sidecar (`service/shacl-runtime`; `SHACL_RUNTIME_URL` / `SHACL_RUNTIME_TOKEN` on `service/api`, `shaclRuntime.enabled` in `charts/signet`): policies using `sh:rule` (TripleRule/SPARQLRule), `sh:function` (SPARQLFunction), or custom SPARQL-based `sh:ConstraintComponent`s are detected per shapes document and routed to `pyshacl@0.40.2+shacl-runtime` (`advanced=True`); the runtime receives PREPARED shapes only (targeting rewritten to focus nodes, RE2-owned `sh:pattern` stripped) plus an N-Quads validation dataset and returns deterministic verdicts that flow into standard reports with the runtime engine id recorded per policy layer; without a configured runtime — or on runtime failure — AF policies fail closed with an explicit `ShaclRuntimeConstraintComponent` violation (never a silent conform); registration validates AF structure (SPARQL-only validators, `sh:ask` for generic validators, fragment-derivable parameter paths, `sh:select`/`sh:construct` safety scans) and refuses `SERVICE`/`REGEX(` in AF queries — re-scanned by the runtime as defense in depth; each validation executes in an rlimit-bounded worker subprocess (memory cap best-effort per platform, CPU backstop, bounded fds, no core dumps) and timeouts hard-kill the worker, so runaway work never lingers or holds capacity (`/healthz` reports worker stats)
- dual ontology packages (`registry_shape` and `skill_area` kinds) as versioned CAS artifacts, resolved by `ontology_version`
- ontology validation of `capability_claims` (concept binding + disjoint-combination checks, propagated transitively through the subclass hierarchy — a claim on a subclass of one disjoint concept combined with a claim on a subclass of the other is rejected with the disjoint ancestor pair as evidence; a single multiply-derived claim covering both sides is not flagged) with de facto candidates recorded in validation reports
- ontology-aware SHACL validation: when a skill-area ontology is bound, the SHACL dataset additionally exposes bound claims as `urn:sg:property:capability_claim_concepts` concept IRIs plus the subclass taxonomy (each `urn:sg:concept:` typed as itself, `rdfs:subClassOf` edges), so authored policies can express `sh:class` constraints that follow the ontology hierarchy; literal `capability_claims` values stay untouched (existing count/in semantics cannot regress) and unbound claims are excluded (they already fail the binding layer)
- certification bound to registered ontology packages (`ONTOLOGY_PACKAGE_NOT_FOUND` when unbound)
- PROV-O provenance: TASK records as `prov:Activity`, versions/artifacts as `prov:Entity`, `PROV_AGENT` records as `prov:Agent`, with `prov:wasDerivedFrom`, `prov:wasGeneratedBy`, `prov:used`, and `prov:wasAssociatedWith` edges written at lifecycle operations
- provenance traversal and audit replay endpoints (`GET .../versions/:v/provenance`) plus the read-only `registry.get_provenance` MCP tool
- canonical provenance export: deterministic PROV-O projection (one triple builder → canonical N-Quads + JSON-LD), RDFC-1.0 digest stored as a content-addressed artifact and carried on every provenance response (`evidence.canonical_rdf_sha256`), with `?format=jsonld` on the skill/agent provenance routes
- detached provenance signatures (`POST .../provenance/signatures`, trusted keys; keyless deferred — needs prepared signed bytes): fail-closed attach over the current export (stale digests rejected, conflicting duplicates 409, identical re-attach idempotent); reads re-verify each signature as `valid`/`invalid`/`stale` (`stale` = signed before the trail grew, signed export still retrievable at its digest) with `all_provenance_signatures_verified` + `current_provenance_signed`; SDK `verifyProvenanceSignature` and `registry-operator verify provenance [--strict]` reproduce verdicts locally
- validation reports as standardized RDF: report artifacts carry a `sh:ValidationReport` JSON-LD representation (SHACL result vocabulary 1:1, layer metadata as `urn:sg:` literals) with its own RDFC-1.0 canonical digest + artifact
- signed validation reports: `POST .../versions/:v/report-signatures` (trusted keys) signs a specific `sg:validatedBy` report artifact over its canonical RDF digest, fail-closed (target must be a SHACL report of this version, key trusted/unexpired, crypto over the canonical bytes; identical re-attach idempotent, conflicting duplicates 409); reports are immutable so verdicts are `valid`/`invalid` — never stale; `GET .../report-signatures` re-verifies rows on read and `registry-operator verify report-signatures [--strict]` reproduces verdicts locally
- evidence transparency coverage: provenance exports, provenance signatures, validation-report RDF artifacts, and report signatures stage append intents through the Tessera sidecar (best-effort like lifecycle events; no sidecar = no-op) and are enumerated by `POST /v1/transparency-logs/reconcile` alongside envelope and governance-artifact intents
- GitHub Actions CI for service/api, service/mcp (including the cognitive layer), service/tessera-sidecar, client/registry-sdk, and client/registry-cli (typecheck, lint, tests), plus an OpenAPI spec/SDK type sync check and npm publish workflows for the SDK and CLI
- canonical governance event JSON (JCS) and digests for all lifecycle operations, stored as immutable CAS artifacts
- internal append-only Merkle log with RFC 6962 inclusion-proof generation and verifier replay (`/v1/governance-log*`)
- governance-event digests staged through the Tessera sidecar for all lifecycle operations when configured
- native RFC 6962 companion transparency log in the Tessera sidecar (S3-backed tree state, signed-note checkpoints, per-entry inclusion proofs; activated by `TESSERA_LOG_PRIVATE_KEY`, origin via `TESSERA_LOG_ORIGIN`) with registry-side reconciliation at `POST /v1/transparency-logs/reconcile`: each recorded append intent is re-fetched, its staged record digest and leaf hash re-derived, its RFC 6962 inclusion proof validated against the signed checkpoint, the checkpoint signature verified against the trusted `TESSERA_LOG_PUBLIC_KEY`, and per-intent outcomes stored as CAS evidence linked `sg:hasTransparencyReconciliation`; the sidecar also serves the C2SP tlog-tiles read API per log (`/tiles/<logId>/checkpoint` + grouped-index `tile/<L>/<N>[.p/<w>]` hash tiles + uint16-length-prefixed `tile/entries/...` bundles computed from current state; stale partial widths and non-canonical paths 404) — layout and serialization fixture-verified against the real transparency-dev `tessera/api` + `api/layout` packages from both Go and TypeScript tests
- canonical RDF (RDFC-1.0) projection of publication graphs with semantic digests recorded at publish and certify
- dual signatures: detached signatures over canonical JSON (operational) or canonical RDF (semantic) bytes with cross-verification
- semantic compiler ingestion: markdown frontmatter and tool-manifest parsing into normalized capability claims, interfaces, and constraints (`POST /v1/compile/skill`)
- de facto vocabulary store with human-reviewed promotion into new normative ontology versions (`/v1/de-facto-terms*`) plus read-only corpus mining (`GET /v1/de-facto-terms/analysis[?ontology_version]`): every capability claim across skill/agent version snapshots is classified bound/unbound against its resolved skill-area ontology, with per-term occurrences, bound/unbound ontology versions, example version urns, and per-ontology drift stats — recording and promotion stay at validation time / human review (no writes)
- advisory LLM validation layer (model-agnostic port, heuristic default, HTTP seam) emitting scorecard/prompt/confidence evidence via `sg:validatedBy`
- human review workflow: `review_evidence` artifacts via `sg:reviewedBy`, policy-driven `require_human_review` gating at publish/certify, pending-review queue (`/v1/reviews/pending`)
- policy-driven publication trust gates: `require_validation` at publish, and `require_signature`, `require_trusted_publisher`, `require_build_provenance`, `require_sbom` at certification (verified signatures owned by the publisher, and verified SLSA/SBOM attestations), each with explicit rejection codes
- verify-then-load consumer contract: client-side verification helpers in the SDK (envelope digest/signature/inclusion-proof/artifact digest), `registry-operator verify publication|artifact`, MCP artifact re-hashing in `verify mcp`, and the model write-up in `docs/supply-chain-model.md`
- single-request sign-then-publish (skills and agents): `prepare-publication` pins the candidate frozen envelope (including reserved transparency append intents); publish accepts `prepared_publication_urn` + `detached_signatures`, re-derives and fail-closes on drift (`*_PUBLISH_PREPARED_STALE`), validates each signature (trusted key, crypto, publisher binding) and freezes the signed envelope in one mutating request; the operator CLI seals seeded skills with it (falling back to envelope-attach when re-seeding already-published versions)
- threat-intel advisories: signed advisory documents (trusted-key verified over JCS bytes) map to publications by exact artifact digest first and identifiers second; `report` (default) lists the affected set, `enforce` auto-revokes revocable matches with actor `threat-intel` (citing the advisory, recording `revocation_advisory_urn`) and stores the advisory as CAS evidence; `GET /v1/advisories[/{id}]` exposes records
- keyless (sigstore) publication signatures: detached signatures may carry a bundle whose Fulcio-style certificate is verified against a configured trust policy (`KEYLESS_TRUSTED_ROOTS` PEM roots/intermediates, `KEYLESS_ALLOWED_ISSUERS`, `KEYLESS_ALLOWED_SUBJECTS` regexes; Rekor trust via `KEYLESS_REKOR_PUBLIC_KEY`/`_LOG_ID`, wired in `env.ts`/`dependencies.ts` with boot-time all-or-nothing validation) — chain to a trusted root, validity window, OIDC issuer extension (v1 and v2 profiles), SAN identity, signature digest + crypto over the signed payload; keyless signatures satisfy `require_signature`, record identity/issuer, and evaluate certificate validity against a trusted time anchor (Fulcio certs live minutes): the signed entry timestamp is verified whenever present and inclusion proofs + checkpoints additionally when present (tlog-carrying bundles fail closed without Rekor trust); integratedTime anchors certificate validity only when the SET authenticated it (`keyless.tlog.integrated_time_verified`), proof-only entries use the registry-witnessed attach time, and attach paths additionally require live-clock certificate validity; the operator CLI signs in CI (`sign keyless`: prepare -> Fulcio via OIDC -> one publish, optional certify) with optional Rekor upload

- authored OWL Turtle ontology packages (`ontology_format: "owl-turtle"` with an explicit `ontology_kind`): a tight, totally-projected subset — `owl:Class`, `rdfs:subClassOf` between declared classes, `owl:disjointWith` (symmetric, normalized), `rdfs:label`, optional `urn:sg:property:concept-id` override, and an `owl:Ontology` header; concept ids default to class-IRI local names and collisions are refused; everything outside the subset is refused at registration (`owl:equivalentClass`, unions/intersections/complements/restrictions, `owl:imports`, `owl:AllDisjointClasses`, `skos:*`, external or blank-node superclasses, unknown statements) — a normative ontology is never silently narrowed; every ontology package, legacy JSON and authored OWL alike, carries an RDFC-1.0 canonical semantic projection (format-independent digest + CAS artifact) recorded on details and the validation report ontology layer (`ontology_format`/`ontology_sha256`/`ontology_canonical_rdf_sha256`); a deterministic authored-OWL writer round-trips documents (source class IRIs preserved, `concept-id` overrides emitted when the IRI local name differs) and powers de-facto promotion: within-format (an `owl-turtle` source promotes into a NEW authored-OWL version with IRIs preserved; legacy JSON sources keep producing legacy JSON versions) or cross-format legacy JSON → authored OWL via an optional `target_ontology_format` (converted through the writer with default `urn:sg:concept:{id}` classes; the reverse direction is refused so authored class IRIs are never silently dropped)

Proposed next:
- SHACL node expressions and `sh:js` (refused at registration; no execution semantics implemented), and an in-process SHACL-AF engine (graph mutation needs an inference-stage design)
- richer PROV-O coverage (JSON-LD export, canonical RDF signatures over provenance graphs)
- deeper witness-network semantics across multiple independent parties
- richer multi-signature observation/gossip provenance

Do not overclaim future guarantees as present behavior.
