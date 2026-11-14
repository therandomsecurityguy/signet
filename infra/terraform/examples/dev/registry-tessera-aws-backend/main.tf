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
    Example = "registry-tessera-aws-backend-dev"
  }
}

module "registry_tessera_aurora" {
  source = "../../../modules/registry-tessera-aurora"

  aws_region                 = var.aws_region
  cluster_identifier         = var.cluster_identifier
  environment                = var.environment
  vpc_id                     = var.vpc_id
  subnet_ids                 = var.subnet_ids
  allowed_security_group_ids = var.allowed_security_group_ids
  allowed_cidr_blocks        = var.allowed_cidr_blocks
  database_name              = var.database_name
  master_username            = var.master_username
  engine_version             = var.engine_version
  serverless_min_capacity    = var.serverless_min_capacity
  serverless_max_capacity    = var.serverless_max_capacity
  instance_count             = var.instance_count
  backup_retention_period    = var.backup_retention_period
  deletion_protection        = var.deletion_protection
  skip_final_snapshot        = var.skip_final_snapshot
  kms_key_arn                = var.kms_key_arn
  secret_name                = var.secret_name
  tags = {
    Example = "registry-tessera-aws-backend-dev"
  }
}

output "bucket_name" {
  value = module.registry_tessera_s3.bucket_name
}

output "aurora_endpoint" {
  value = module.registry_tessera_aurora.cluster_endpoint
}

output "registry_artifact_env" {
  sensitive = true
  value     = module.registry_tessera_s3.registry_artifact_env
}

output "tessera_sidecar_env" {
  sensitive = true
  value     = module.registry_tessera_s3.tessera_sidecar_env
}

output "tessera_runtime_env" {
  sensitive = true
  value = join("\n", [
    "TESSERA_AWS_REGION=${var.aws_region}",
    "TESSERA_BUCKET=${module.registry_tessera_s3.bucket_name}",
    "TESSERA_DB_SECRET_ARN=${module.registry_tessera_aurora.secret_arn}",
  ])
}

output "ssm_parameter_names" {
  value = module.registry_tessera_s3.ssm_parameter_names
}

output "secret_arn" {
  value = module.registry_tessera_aurora.secret_arn
}
