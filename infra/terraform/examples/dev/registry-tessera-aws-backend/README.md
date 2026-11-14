## Dev Example - Registry/Tessera AWS Backend

This example provisions the minimal AWS shape for the current productionization seam:
- one shared S3 bucket for registry artifacts plus Tessera tiles/requests
- one Aurora MySQL Serverless v2 cluster for the Tessera runtime backend
- one Secrets Manager secret that the runtime can consume via `TESSERA_DB_SECRET_ARN`

From this directory:

```bash
cd signet/infra/terraform/examples/dev/registry-tessera-aws-backend
cp terraform.tfvars.example terraform.tfvars
terraform init
terraform plan
terraform apply
```

Useful outputs after apply:
- `registry_artifact_env`
- `tessera_sidecar_env`
- `tessera_runtime_env`
- `ssm_parameter_names`
- `secret_arn`

Typical next step:
1. wire the outputs into the compose-backed service env files:

```bash
cd signet/infra
make wire-tessera-aws
```

2. start the optional Tessera companion profile:

```bash
cd signet/infra
make up-tessera
```

3. keep `secret_arn` or the `ssm_parameter_names` in remote state if you want other stacks to resolve them indirectly
