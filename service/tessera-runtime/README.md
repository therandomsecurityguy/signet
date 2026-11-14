## `service/tessera-runtime` - Tessera Runtime Companion

This service is the first real Tessera-backed runtime companion for **Signet**.

Implemented now:
- Tessera appender initialization using the AWS storage shape
- local/dev HTTP endpoint for adding entries
- local/dev health and config endpoints
- optional use of a real S3 bucket plus a local MySQL-compatible database

Important boundary:
- this is still a narrow companion, not the canonical trust authority
- `service/registry` remains the governance and verification core

### Current role

The intended flow is:
1. `service/api` publishes or certifies governed content
2. `service/registry` stages an append intent through `service/tessera-sidecar`
3. the sidecar submits the append record into this Tessera runtime
4. the runtime returns a durable entry index
5. the runtime can also surface a published checkpoint reference once the entry is committed by a checkpoint
6. the sidecar returns that runtime metadata back into the registry trust model

### Endpoints

- `GET /healthz`
- `GET /readyz`
- `GET /v1`
- `POST /v1/entries`

### Local dev

Use the optional compose profile:

```bash
cd signet/infra
make up-tessera
```

This profile is intended for experiments and integration work. It is not yet a polished production deployment path.

### AWS deployment seam

The repo now includes a minimal AWS-oriented productionization path for this runtime:
- S3 for Tessera tile/checkpoint storage
- Aurora MySQL Serverless v2 for the Tessera AWS backend state
- Secrets Manager for the runtime DB connection payload

The runtime can be configured in one of two ways:
- local/dev direct env vars: `TESSERA_DB_HOST`, `TESSERA_DB_PORT`, `TESSERA_DB_NAME`, `TESSERA_DB_USER`, `TESSERA_DB_PASSWORD`
- AWS-style indirection: `TESSERA_AWS_REGION`, `TESSERA_BUCKET`, `TESSERA_DB_SECRET_ARN`

The combined Terraform example lives at:
- `infra/terraform/examples/dev/registry-tessera-aws-backend`

That example emits three useful outputs:
- `registry_artifact_env`
- `tessera_sidecar_env`
- `tessera_runtime_env`

The current in-repo deployment path is compose-backed service env files, so after `terraform apply` the fastest operator path is:

```bash
cd signet/infra
make wire-tessera-aws
```

That writes a managed Terraform-backed override block into the env files consumed by `service/api`, `service/tessera-sidecar`, and `service/tessera-runtime`.

The secret payload expected by `TESSERA_DB_SECRET_ARN` is JSON with:
- `host`
- `port`
- `db_name` (or `database`)
- `username` (or `user`)
- `password`
