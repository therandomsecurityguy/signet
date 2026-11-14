# signet-eks

Thin wrapper that installs a **version-pinned** signet Helm chart into an
existing EKS namespace. This repo ships the chart; the environment repo
(`tf-io-sec`) owns Terraform state/apply and calls this module.

```hcl
module "signet" {
  source = "../../modules/signet-eks"

  chart_repository = "oci://${var.ecr_registry}/charts"
  chart_version    = "0.1.0"
  namespace        = "signet"
  values_files     = ["${path.module}/values/signet-prod.yaml"]
  set_values = {
    "image.registry"        = var.ecr_registry
    "serviceAccount.roleArn" = module.signet_data.eso_role_arn
    "secrets.external.prefix" = module.signet_data.secret_prefix
  }
}
```

The two-repo rule: this repo publishes immutable chart/image artifacts on tag;
`tf-io-sec` pins the tag and applies. Never apply directly from CI against prod.
