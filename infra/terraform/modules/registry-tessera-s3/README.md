## `registry-tessera-s3`

Terraform module for a shared S3 bucket used by:
- the registry S3 artifact CAS
- a future or companion Tessera/Tessera-sidecar path

### Security posture

Implemented now:
- public access block enabled
- versioning enabled
- default encryption enabled
- deny insecure transport bucket policy

Optional:
- KMS-backed encryption via `kms_key_arn`
- explicit read/write principal allow lists
- SSM parameter publication for indirect config lookup

### Intended prefixes

- `registry_artifact_prefix`
  - registry CAS objects
- `tessera_tiles_prefix`
  - Tessera tiles/checkpoints
- `tessera_requests_prefix`
  - sidecar append-intent/request objects

### Typical usage

```hcl
module "registry_tessera_s3" {
  source = "../../modules/registry-tessera-s3"

  bucket_name             = "my-agents-registry-dev"
  environment             = "dev"
  registry_artifact_prefix = "registry/artifacts/dev"
  tessera_tiles_prefix     = "tessera/tiles/dev"
  tessera_requests_prefix  = "tessera/requests/dev"

  allowed_read_principal_arns  = ["arn:aws:iam::123456789012:role/registry-read"]
  allowed_write_principal_arns = ["arn:aws:iam::123456789012:role/registry-write"]
}
```

### Useful outputs

- `registry_artifact_env`
- `tessera_sidecar_env`
- `ssm_parameter_names`

These can be consumed by remote state, copied into env files, or resolved via a separate secret/config workflow.
