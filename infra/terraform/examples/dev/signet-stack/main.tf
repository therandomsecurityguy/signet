terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
    helm = {
      source  = "hashicorp/helm"
      version = ">= 3.0, < 4.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

module "signet_registry" {
  source = "../../../modules/signet-registry"

  environment       = var.environment
  github_repository = var.github_repository
  github_subjects   = var.github_subjects
  tags              = var.tags
}

module "signet_data" {
  source = "../../../modules/signet-data"

  environment                = var.environment
  region                     = var.aws_region
  vpc_id                     = var.vpc_id
  private_subnet_ids         = var.private_subnet_ids
  allowed_security_group_ids = var.allowed_security_group_ids
  allowed_cidr_blocks        = var.allowed_cidr_blocks

  artifact_bucket_name = var.artifact_bucket_name

  eks_oidc_provider_arn    = var.eks_oidc_provider_arn
  eso_namespace            = var.namespace
  eso_service_account_name = "signet"

  db_multi_az                    = var.db_multi_az
  db_deletion_protection         = var.db_deletion_protection
  redis_num_cache_clusters       = var.redis_num_cache_clusters
  redis_multi_az                 = var.redis_multi_az
  secret_recovery_window_in_days = var.secret_recovery_window_in_days

  tags = var.tags
}

module "signet" {
  source = "../../../modules/signet-eks"

  chart_repository = "oci://${module.signet_registry.registry_host}/charts"
  chart_version    = var.chart_version
  namespace        = var.namespace
  values_files     = [var.values_file]
  set_values = {
    "image.registry"          = module.signet_registry.registry_host
    "serviceAccount.roleArn"  = module.signet_data.eso_role_arn
    "secrets.external.prefix" = module.signet_data.secret_prefix
    "artifacts.s3.bucket"     = module.signet_data.artifact_bucket_name
  }
}
