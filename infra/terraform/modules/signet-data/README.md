# signet-data

Provisions the signet data plane into an account/VPC you own:

- **KMS CMK** (rotation enabled) encrypting secrets, S3, RDS and Redis.
- **Secrets Manager** containers under `<secret_prefix>/<key>`, matching the
  chart's `ExternalSecret` remoteRef paths.
  - Generated (Terraform-managed version): `database-url`,
    `fuseki-admin-password`, `redis-url`.
  - Operator-seeded (no version in state): `okta-client-secret`,
    `tessera-log-private-key`. Seed these with `aws secretsmanager
    put-secret-value` — never through Terraform state or Helm values.
- **S3 artifact bucket**: versioned, public-access blocked, KMS-encrypted. Registry
  workloads reach it via **IRSA** (the release service account's role), not static
  access keys.
- **RDS Postgres**: encrypted, private, IAM authentication enabled,
  deletion protection/backups configurable.
- **ElastiCache Redis**: TLS + token auth, encrypted at rest.
- **IRSA role**: one role for the release service account covering both ESO
  (reads the secret prefix) and artifact-bucket access.

## Usage

```hcl
module "signet_data" {
  source = "../../modules/signet-data"

  environment          = "prod"
  vpc_id               = var.vpc_id
  private_subnet_ids   = var.private_subnet_ids
  allowed_security_group_ids = [var.eks_node_security_group_id]

  artifact_bucket_name = "signet-prod-artifacts"

  eks_oidc_provider_arn = var.eks_oidc_provider_arn
  eso_namespace         = "signet"
  eso_service_account_name = "signet"

  db_multi_az            = true
  db_deletion_protection = true
  redis_num_cache_clusters = 2
  redis_multi_az         = true
}
```

Then seed the operator secrets out-of-band (never committed):

```sh
aws secretsmanager put-secret-value \
  --secret-id signet-prod/runtime/okta-client-secret \
  --secret-string '<value>'
aws secretsmanager put-secret-value \
  --secret-id signet-prod/runtime/tessera-log-private-key \
  --secret-string file:///secure/path/tessera-log-key.pem
```

The `tessera-log-private-key` must be **byte-identical** to the key used by the
deployment you are migrating from — a different key breaks the transparency log
signature chain.

## Security notes

- No secret *values* are ever passed as module variables, so nothing sensitive
  lands in Terraform state except the generated credentials (which Terraform
  must own to rotate).
- Prefer `allowed_security_group_ids` (EKS node/pod SG) over CIDRs.
- Set `secret_recovery_window_in_days = 0` only in dev/test.
