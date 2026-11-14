# Signet chart — secrets

Signet's secrets live in **AWS Secrets Manager** and are injected into the
`signet` Kubernetes Secret by an ExternalSecret (ESO). The chart renders the
SecretStore and ExternalSecret when `secrets.external.enabled: true` (set in
`values-<env>.yaml`); the workloads reference the `signet` Secret via
`secretKeyRef`.

The SecretStore is **owned by this release** (`secrets.external.createSecretStore:
true`) and authenticates to AWS with **IRSA** — the release ServiceAccount
carries `eks.amazonaws.com/role-arn`, bound by the `signet-data` Terraform module
to a role allowed to read the secret prefix. There is no platform-provisioned
store and no static AWS credentials in the chart.

## Secrets Manager keys

One Secrets Manager secret per key, under `<secret_prefix>/` (default
`signet-<env>/runtime`):

| Secrets Manager key (`<prefix>/<key>`) | k8s Secret key | Used by |
|---|---|---|
| `okta-client-secret` | `okta-client-secret` | webapp |
| `database-url` | `database-url` | api, mcp |
| `fuseki-admin-password` | `fuseki-admin-password` | fuseki |
| `redis-url` | `redis-url` | api, mcp |
| `api-key-pepper` | `api-key-pepper` | api, mcp |
| `tessera-log-private-key` | `tessera-log-private-key` | tessera-sidecar |
| `tessera-sidecar-auth-token` | `tessera-sidecar-auth-token` | api, tessera-sidecar |

S3 artifact access uses **IRSA**, not static keys: the release ServiceAccount's
role (from the `signet-data` module) grants the artifact-bucket policy, and the
AWS SDK picks up the web-identity credentials automatically. There are no
`s3-*` secret keys.

## Who owns which secret

- **Terraform-generated** (values in state, rotated by Terraform):
  `database-url`, `fuseki-admin-password`, `redis-url`, `api-key-pepper`. Created
  by the `signet-data` module.
- **Operator-seeded** (never in Terraform state, never in Helm values):
  `okta-client-secret`, `tessera-log-private-key`,
  `tessera-sidecar-auth-token`.

## Seeding operator secrets

Seed once per env with the AWS CLI (values are not committed anywhere):

```bash
aws secretsmanager put-secret-value \
  --secret-id signet-prod/runtime/okta-client-secret \
  --secret-string "<okta-client-secret>"

# Transparency-log signer key. This MUST be byte-identical to the key used by
# the deployment you are migrating from — a different key breaks the signature
# chain. Export it from the source path, do not regenerate.
aws secretsmanager put-secret-value \
  --secret-id signet-prod/runtime/tessera-log-private-key \
  --secret-string file:///secure/path/tessera-log-key.pem
```

Rotate by updating the Secrets Manager value; ESO re-syncs on `refreshInterval`.
Set `secrets.external.refreshInterval` to control how quickly.

The tessera-sidecar fails closed: without `tessera-sidecar-auth-token`,
`/v1/*` returns 401. Seed it to enable bearer auth (the api presents the same
token on append/reconcile calls), or set
`tesseraSidecar.allowUnauthenticated: true` for local-development clusters
only:

```bash
aws secretsmanager put-secret-value \
  --secret-id signet-prod/runtime/tessera-sidecar-auth-token \
  --secret-string "$(openssl rand -hex 32)"
```

The k8s env is `optional: true` so pods start before the key is seeded — but
the sidecar then rejects `/v1/*` with `SIDECAR_AUTH_NOT_CONFIGURED` until the
token (or the explicit local-development opt-out) is configured.

The matching checkpoint **public** key is not a secret. Set
`tesseraSidecar.logPublicKeyPem` to its PEM content (derive from the seeded
private key with `openssl pkey -pubout`) to enable registry-side transparency
reconciliation (`POST /v1/transparency-logs/reconcile`).

## Non-secret per-env values

`values-<env>.yaml` carries non-secret placeholders filled by the environment
repo:

- `image.registry` — the ECR account, e.g. `<account-id>.dkr.ecr.<region>.amazonaws.com`
- `auth.oktaIssuer` / `auth.oktaClientId` — from your OIDC app
- `artifacts.s3.bucket` — the S3 artifact bucket
- `serviceAccount.roleArn` — the ESO IRSA role from `signet-data`
- `secrets.external.prefix` — the Secrets Manager prefix from `signet-data`
- `networkPolicies.egressCidrs` — the VPC CIDRs hosting Postgres/Redis
