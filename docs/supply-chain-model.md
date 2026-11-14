# Supply chain model

How Cachet protects the agent supply chain: what travels through the registry,
where trust is established, and which controls exist today versus what is
proposed next.

The model covers four control points, in the order content moves through them:

| Control point | Question | Cachet controls |
| --- | --- | --- |
| **Publish** | Is this release what it claims to be, and is the publisher authorized? | signed/frozen publication envelopes, DSSE/in-toto attestations, policy trust gates, trusted publishers, human review, transparency log |
| **Resolve** | Does a consumer get exactly the verified bytes? | verification API, `registry.verify_publication`, MCP read gates for revoked/unverified content, frozen envelope artifacts, pinned versions |
| **Execute** | Does the runtime check before loading? | verify-then-load contract: SDK/CLI verification helpers, artifact digest checks, `verify mcp` re-hashing |
| **Operate** | Is what we deploy what we released? | digest-pinned immutable releases, keyless cosign signatures, GitHub build provenance, SPDX SBOMs, release signature verification before apply |

## Publish

- Publishing freezes the canonical JSON envelope as a CAS artifact and records
  its digest (`publication_envelope_artifact_urn`,
  `publication_envelope_sha256`). Later evidence (reviews, certification,
  attestations) never mutates the published bytes.
- Detached signatures cover canonical JSON (JCS/RFC 8785) or canonical RDF
  (RDFC-1.0) bytes; verification resolves keys through trusted `PUBLIC_KEY`
  records with trust windows and revocation.
- **DSSE/in-toto attestations** (`POST /v1/attestations`) carry build
  provenance, SBOMs, and scan results. Signatures are verified over DSSE PAE
  bytes; subjects must match the publication's artifacts; only verified
  evidence is stored (`sg:attestedBy`).
- **Policy trust gates** bind at publication time: `require_validation` blocks
  publish for drafts; `require_signature`, `require_trusted_publisher`,
  `require_build_provenance`, and `require_sbom` bind at certification against
  the frozen envelope and the evidence attached after publish. When a policy
  requires a trusted publisher, signatures are only accepted from a trusted
  key whose owner matches the publication's publisher.
- **Keyless (sigstore) signatures**: signatures may carry a sigstore bundle
  whose certificate chains to a configured trust policy (trusted roots,
  allowed OIDC issuers, allowed subject patterns). The registry verifies the
  chain, validity window, issuer extension (v1/v2), SAN identity, and the
  bundle's message digest + signature over the frozen bytes; keyless
  signatures count for `require_signature` and record the signing identity
  instead of a registered key. Fulcio certificates live minutes, so stored
  records are re-verified against the registry-witnessed attach time
  (`signed_at`, exposed as `keyless.validity_evaluated_at`) rather than the
  wall clock — attach itself verifies chain, policy, digest, and signature
  against the current time and fails closed. Bundles are stored in the
  signature CAS document. CI signing is built in: `registry-operator sign
  keyless` exchanges the workflow's GitHub OIDC identity at Fulcio, signs the
  prepared candidate bytes, and publishes in one request (optional
  `--certify`, optional Rekor upload); see
  `docs/runbooks/keyless-publishing.md`. Rekor anchoring is verified when
  configured (`KEYLESS_REKOR_PUBLIC_KEY`/`_LOG_ID`): signed entry timestamps
  are checked against the log's public key whenever present, inclusion proofs
  + checkpoints additionally when present, the hashedrekord entry must be
  bound to the signed payload, and certificate validity anchors at the
  attested integratedTime only when the SET authenticated it (proof-only
  entries use the witnessed attach time; attach always requires live-clock
  validity); bundles carrying a tlog entry fail closed when Rekor trust is
  not configured.
- **Single-request sign-then-publish**: `POST
  /v1/{skills|agents}/{key}/versions/{version}/prepare-publication` pins the
  exact envelope publish would freeze (including the server-volatile values —
  `published_at`, `updated_at`, and reserved transparency append intents) as a
  prepared-publication artifact. The client signs those bytes, then the single
  mutating publish accepts `prepared_publication_urn` plus
  `detached_signatures`; publish re-derives the candidate from current state
  and refuses to proceed (`*_PUBLISH_PREPARED_STALE`) unless the bytes are
  identical, validates each signature over the prepared payload
  (trusted key, cryptographic verification, publisher binding —
  `*_SIGNATURE_INVALID` / `*_SIGNATURE_PUBLISHER_MISMATCH`), and freezes the
  signed envelope in the same request. The legacy publish → sign → certify
  flow keeps working, and the operator CLI seals seeded skills with the
  single request (falling back to envelope-attach when re-seeding an
  already-published version).
- Governance events are appended to an RFC 6962 Merkle log with checkpoints,
  witness quorum, and consistency proofs; publication append intents are
  staged through the Tessera sidecar when configured, and the sidecar can run
  a native RFC 6962 companion log (S3-backed tree state, signed-note
  checkpoints, per-entry inclusion proofs) when `TESSERA_LOG_PRIVATE_KEY` is
  configured.
- `POST /v1/transparency-logs/reconcile` reconciles a published version
  against that companion log: it re-fetches each recorded append intent's
  entry, re-derives the staged record digest and leaf hash, validates the
  RFC 6962 inclusion proof against the signed checkpoint, verifies the
  checkpoint signature against the trusted `TESSERA_LOG_PUBLIC_KEY`, and
  stores the per-intent outcomes as CAS evidence linked
  `sg:hasTransparencyReconciliation` (envelopes are not modified).

## Resolve

- `GET …/versions/:v/verification` and the MCP tool
  `registry.verify_publication` return the trust verdicts: envelope digests,
  frozen-envelope presence/digest match, live drift, per-signature
  cryptographic and transparency results, and attestation summaries.
- `GET /v1/artifacts/{sha256}` transports bytes with `Content-Digest` and
  fail-closed digest verification; CAS reads re-hash and can be set to
  `enforce` (`REGISTRY_ARTIFACT_INTEGRITY_MODE`).
- **Read gates** deny unsafe content before it leaves the read plane:
  revoked publications are denied by default (`REGISTRY_READ_DENY_REVOKED`,
  opt out with `false`), and unverified publications can be denied with
  `REGISTRY_READ_REQUIRE_VERIFIED=true`. `registry.verify_publication` itself
  is never gated: verification is how a consumer discovers a problem.

## Execute

The verify-then-load contract (see `adoption.md`) moves verification to the
consumer:

- `@signet/registry-sdk` ships `verifyEnvelopeSignatures`,
  `verifyDetachedSignature`, `verifyRfc6962InclusionProof`, and
  `fetchArtifact` (local re-hash against the requested digest and the
  `Content-Digest` header).
- `registry-operator verify publication (--skill|--agent) --version <n>
  [--strict]` reproduces the verdict in the CLI, and
  `registry-operator verify artifact` checks bytes.
- `verify mcp` re-hashes every artifact fetched through MCP instead of only
  checking tool success.

## Operate

- Releases publish immutable, digest-pinned images and the OCI chart.
- Every release is **keyless-signed** (cosign via GitHub OIDC): images, chart,
  and `release-manifest.json` (with its Sigstore bundle).
- **GitHub build provenance** attestations are created for the images and the
  chart; **SPDX SBOMs** (syft) are attached to the registry and uploaded with
  the release.
- `scripts/verify-release-signatures.sh <tag>` verifies the manifest bundle,
  every image, and the chart against the release workflow's OIDC identity.
  The tf-io-sec kube plan runs the same check on every PR touching a cachet
  unit, and the runbook makes it a stop before manual applies.
- **Threat-intel advisories**: `POST /v1/advisories` accepts signed advisory
  documents (signature over the JCS-canonical bytes, verified against trusted
  keys), maps them to publications by exact artifact digest first and
  identifiers (skill/agent key with an optional version lock) second, and
  records the advisory as immutable CAS evidence (`GET /v1/advisories[/{id}]`).
  `mode: "enforce"` auto-revokes revocable matches with actor `threat-intel`,
  cites the advisory in the revocation reason, and records
  `revocation_advisory_urn` on the version; MCP read gates already deny
  revoked publications by default. `report` (the default) returns the
  affected set without mutating anything, so a bad feed can be reviewed
  before enforcement.

## What is not implemented (proposed next)

- TUF metadata and key-rotation policy enforcement for trust roots.
- Keyless publication signatures (Fulcio-issued envelopes) for registry
  publications themselves.
- Full Trillian/Tessera tile-format interop: the native companion log uses
  RFC 6962 proofs and signed-note checkpoints with its own S3 layout, not
  tessera binary tiles; checkpoint gossip to external monitors and witness
  policy enforcement remain proposed next.
- npm trusted publishing for the SDK/CLI: the publish workflows now
  authenticate via OIDC (no `NPM_TOKEN`); the first publish of each package
  is still manual on npmjs.com (trusted publishers require the package to
  exist). Build-provenance attestations are currently disabled because npm
  rejects sigstore bundles from `internal`-visibility source repos (E422);
  they can be re-enabled if this repository becomes public. Staged
  publishing (`npm stage publish` + maintainer approval) is the next
  tightening. See `docs/runbooks/npm-release.md` and
  `scripts/configure-npm-trusted-publishing.sh`.
