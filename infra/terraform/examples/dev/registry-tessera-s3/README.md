## Dev Example - Registry/Tessera S3 Bucket

From this directory:

```bash
cd signet/infra/terraform/examples/dev/registry-tessera-s3
cp terraform.tfvars.example terraform.tfvars
terraform init
terraform plan
terraform apply
```

Useful outputs after apply:
- `bucket_name`
- `registry_artifact_env`
- `tessera_sidecar_env`
- `ssm_parameter_names`

Typical next step:
1. copy `registry_artifact_env` into `service/api/infra/.env` and `service/mcp/infra/.env`
2. copy `tessera_sidecar_env` into `service/tessera-sidecar/infra/.env`
3. start the optional sidecar profile with:

```bash
cd signet/infra
make up-tessera
```
