terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

module "registry_tessera_s3" {
  source = "../../../modules/registry-tessera-s3"

  bucket_name                  = var.bucket_name
  environment                  = var.environment
  force_destroy                = var.force_destroy
  kms_key_arn                  = var.kms_key_arn
  registry_artifact_prefix     = var.registry_artifact_prefix
  tessera_tiles_prefix         = var.tessera_tiles_prefix
  tessera_requests_prefix      = var.tessera_requests_prefix
  allowed_read_principal_arns  = var.allowed_read_principal_arns
  allowed_write_principal_arns = var.allowed_write_principal_arns
  create_ssm_config_parameters = var.create_ssm_config_parameters
  ssm_parameter_prefix         = var.ssm_parameter_prefix
  tags = {
    Example = "registry-tessera-s3-dev"
  }
}

output "bucket_name" {
  value = module.registry_tessera_s3.bucket_name
}

output "registry_artifact_env" {
  sensitive = true
  value     = module.registry_tessera_s3.registry_artifact_env
}

output "tessera_sidecar_env" {
  sensitive = true
  value     = module.registry_tessera_s3.tessera_sidecar_env
}

output "ssm_parameter_names" {
  value = module.registry_tessera_s3.ssm_parameter_names
}
