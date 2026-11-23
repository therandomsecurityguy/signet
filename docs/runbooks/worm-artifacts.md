# WORM artifact storage (S3 Object Lock)

Signet artifacts are content-addressed (the object key is the sha256 of the
bytes) and fail closed on read when bytes drift, but the *storage backend*
is what physically prevents deletion or overwrite. On AWS this is S3 Object
Lock. This runbook covers enabling it and reading the per-artifact
immutability report.

## Enable Object Lock (create-time only)

S3 Object Lock can only be enabled when the bucket is created — it cannot
be turned on for an existing bucket. In the environment repo that owns
Terraform state, update the artifact bucket (from the `signet-data`
module's inputs) when standing up a new environment:

```hcl
resource "aws_s3_bucket" "artifacts" {
  bucket = "signet-artifacts-<env>"

  # WORM: artifacts are immutable once written. Enabling at creation is the
  # only opportunity (AWS rejects adding Object Lock later); bucket
  # versioning is required and enabled automatically.
  object_lock_enabled = true
}

resource "aws_s3_bucket_object_lock_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  rule {
    default_retention {
      # COMPLIANCE: no principal (including root) can delete or shorten
      # retention. GOVERNANCE allows a privileged bypass — use it only if
      # you need that escape hatch; the immutability report distinguishes
      # the two modes.
      mode = "COMPLIANCE"
      days = 365
    }
  }
}
```

Notes:
- Every writer (api artifact CAS) needs `s3:PutObjectRetention`/baggage only
  at bucket setup; ordinary `PutObject` inherits the default retention, so
  application credentials need no Object Lock permissions.
- Existing objects in a non-locked bucket are not retroactively protected;
  migrate by re-uploading them into the locked bucket (content addressing
  makes this a pure copy).
- The file-system CAS backend (`REGISTRY_ARTIFACT_BACKEND=fs`) cannot
  enforce WORM; it is for local development.

## Verify per artifact (read-only)

`service/api` exposes an immutability report per artifact:

```bash
curl -s "$API/v1/artifacts/<sha256>/retention" | jq
# -> { "sha256": "...", "present": true,
#      "object_lock": { "mode": "COMPLIANCE", "retain_until": "2027-…",
#                       "legal_hold": false },
#      "immutability_enforced": true }
```

- `object_lock: null` + `immutability_enforced: false` means the backend
  cannot report Object Lock (file system) — expected only in dev.
- `immutability_enforced` is true for COMPLIANCE, and for GOVERNANCE while
  the retention window is active.
- An artifact whose bytes no longer match its digest is already rejected by
  the read path (`ARTIFACT_DIGEST_MISMATCH`), independently of Object Lock.

Retention is reported from the bucket configuration, not from Signet
metadata, so it proves what the storage layer actually enforces.
