## Artifact Storage

This document explains how artifact bytes are stored in Signet today and how the artifact layer is prepared for S3-backed persistence.

## Current local layout

For local development, registry bytes live under:
- `data/registry/graph/`
- `data/registry/objects/`

Meaning:
- graph and metadata live in the graph backend
- artifact bytes live in the content-addressed object store

Current documented metadata default:
- local `json_file` via `data/registry/graph/registry-state.json`

Optional metadata backend:
- Fuseki-backed `sparql` for inspection and live validation

## Current filename/key scheme

Artifacts are stored by `sha256`.

Local filesystem object path shape:

```text
data/registry/objects/<first-two-hex>/<full-sha256>
```

Example:

```text
data/registry/objects/f5/f5335ed75c09e3ffdbd28f8414bfb8dc8bc3e89d87b9b83753e7c8c3327e1c06
```

This is intentionally not human-readable.

## Decision

Keep the object-store key content-addressed and opaque.

Do not switch the backing blob filename or S3 object key to a natural key like skill name or original filename.

Treat the current opacity as a feature:
- stable identity by content
- deduplication by construction
- cheap integrity verification
- lower accidental out-of-band mutation risk
- cleaner separation between governed metadata and raw bytes

Human-readable meaning should live in registry metadata:
- `skill_key`
- `agent_key`
- `artifact_urn`
- `original_path`
- `display_name`
- lifecycle and lineage fields

## Read verification (supply chain)

Content addressing is only useful if reads are checked. Both CAS backends now
recompute the SHA-256 of the bytes they read and report `digest_verified`:

- `REGISTRY_ARTIFACT_INTEGRITY_MODE=warn` (default): the read still returns the
  bytes, with `digest_verified: false` when they do not match the requested
  content address. The artifact fetch surface exposes the flag.
- `REGISTRY_ARTIFACT_INTEGRITY_MODE=enforce`: a mismatch fails the read.
  `getArtifact` maps it to `ARTIFACT_DIGEST_MISMATCH`, so tampered bytes can
  never be silently used.

Frozen publication envelopes are stored in the same CAS
(`generated/publication-envelope/<logical-key>.json`). The envelope endpoint
only serves the frozen bytes when they still pass this check; otherwise it
falls back to the derived payload and verification reports
`publication_envelope_artifact_sha256_matches: false`.

## Byte transport (`service/api`)

`GET /v1/artifacts/{sha256}` (and HEAD) transports raw artifact bytes from the
management plane:

- `Content-Digest` carries the RFC 9530 structured field (`sha-256=:...:`).
- `x-artifact-digest-verified: true` confirms the bytes were re-hashed on this
  read.
- A mismatch is never transported: the response is
  `409 ARTIFACT_DIGEST_MISMATCH`, regardless of the CAS integrity mode.
- `media_type` is resolved from the CAS record (S3 object content type) or,
  for filesystem stores, from the linked `ARTIFACT` node.

## S3 preparation

The registry artifact layer is now prepared to use either:
- filesystem CAS: `REGISTRY_ARTIFACT_BACKEND=fs`
- S3 CAS: `REGISTRY_ARTIFACT_BACKEND=s3`

The key shape remains content-addressed in both backends.

S3 object key shape:

```text
<optional-prefix>/<first-two-hex>/<full-sha256>
```

Example with prefix:

```text
signet/dev/f5/f5335ed75c09e3ffdbd28f8414bfb8dc8bc3e89d87b9b83753e7c8c3327e1c06
```

## Activation env

### Local filesystem CAS

```bash
REGISTRY_ARTIFACT_BACKEND=fs
REGISTRY_OBJECTS_DIR=/workspace/data/registry/objects
```

### S3-backed CAS

```bash
REGISTRY_ARTIFACT_BACKEND=s3
REGISTRY_S3_BUCKET=your-registry-artifacts-bucket
REGISTRY_S3_PREFIX=signet/dev
REGISTRY_S3_REGION=us-west-2
```

Optional for S3-compatible local or custom endpoints:

```bash
REGISTRY_S3_ENDPOINT=http://minio:9000
REGISTRY_S3_FORCE_PATH_STYLE=true
REGISTRY_S3_ACCESS_KEY_ID=minio
REGISTRY_S3_SECRET_ACCESS_KEY=minio-secret
REGISTRY_S3_SESSION_TOKEN=optional
```

## Scope of current preparation

Prepared now:
- pluggable registry artifact store backend
- filesystem CAS remains default
- S3 CAS implementation is available behind env config
- ingest/bootstrap paths honor the same artifact backend selection

Not changed yet:
- time-aware object storage backend
- infra provisioning for buckets, IAM, lifecycle policies, or encryption (a Terraform module under `infra/terraform/` provisions a shared bucket seam)

## Recommendation for rollout

1. Keep local development on `fs`.
2. Introduce S3 first in a beta or staging environment.
3. Keep the graph metadata authoritative for discovery and governance.
4. Add bucket-level controls:
   - encryption
   - versioning decision
   - lifecycle rules
   - access logging / audit trail
5. Add operational tooling for human inspection rather than changing the CAS key scheme.

## Better human affordances later

If humans need friendlier inspection, prefer:
- a registry export tool
- a “materialize artifact to readable path” command
- webapp views that resolve metadata to artifact content
- reporting/index pages

Do not overload the raw storage key with human meaning.
