# cachet-eks

Thin wrapper that installs a **version-pinned** cachet Helm chart into an
existing EKS namespace. This repo ships the chart; the environment repo
(`tf-io-sec`) owns Terraform state/apply and calls this module.

```hcl
module "cachet" {
  source = "../../modules/cachet-eks"

  chart_repository = "oci://${var.ecr_registry}/charts"
  chart_version    = "0.1.0"
  namespace        = "cachet"
  values_files     = ["${path.module}/values/cachet-prod.yaml"]
  set_values = {
    "image.registry"        = var.ecr_registry
    "serviceAccount.roleArn" = module.cachet_data.eso_role_arn
    "secrets.external.prefix" = module.cachet_data.secret_prefix
  }
}
```

The two-repo rule: this repo publishes immutable chart/image artifacts on tag;
`tf-io-sec` pins the tag and applies. Never apply directly from CI against prod.
