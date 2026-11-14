variable "aws_region" {
  description = "AWS region for the shared bucket and Aurora cluster."
  type        = string
  default     = "us-west-2"
}

variable "environment" {
  description = "Environment label."
  type        = string
  default     = "dev"
}

variable "bucket_name" {
  description = "Shared S3 bucket name."
  type        = string
}

variable "cluster_identifier" {
  description = "Aurora cluster identifier."
  type        = string
  default     = "agents-registry-tessera-dev"
}

variable "vpc_id" {
  description = "VPC ID hosting Aurora."
  type        = string
}

variable "subnet_ids" {
  description = "Private subnet IDs for Aurora."
  type        = list(string)
}

variable "allowed_security_group_ids" {
  description = "Security groups allowed to reach Aurora."
  type        = list(string)
  default     = []
}

variable "allowed_cidr_blocks" {
  description = "CIDR blocks allowed to reach Aurora."
  type        = list(string)
  default     = []
}

variable "database_name" {
  description = "Tessera database name."
  type        = string
  default     = "tessera"
}

variable "master_username" {
  description = "Tessera database master username."
  type        = string
  default     = "tessera"
}

variable "engine_version" {
  description = "Aurora MySQL engine version."
  type        = string
  default     = "8.0.mysql_aurora.3.08.0"
}

variable "serverless_min_capacity" {
  description = "Aurora Serverless v2 minimum ACUs."
  type        = number
  default     = 0.5
}

variable "serverless_max_capacity" {
  description = "Aurora Serverless v2 maximum ACUs."
  type        = number
  default     = 4
}

variable "instance_count" {
  description = "Aurora instance count."
  type        = number
  default     = 1
}

variable "backup_retention_period" {
  description = "Aurora backup retention in days."
  type        = number
  default     = 7
}

variable "deletion_protection" {
  description = "Enable deletion protection for Aurora."
  type        = bool
  default     = false
}

variable "skip_final_snapshot" {
  description = "Skip the final snapshot on destroy."
  type        = bool
  default     = true
}

variable "kms_key_arn" {
  description = "Optional KMS key ARN for S3, Aurora, and Secrets Manager."
  type        = string
  default     = null
}

variable "secret_name" {
  description = "Optional explicit Secrets Manager name for the Tessera DB secret."
  type        = string
  default     = null
}

variable "registry_artifact_prefix" {
  description = "Prefix for registry CAS artifacts."
  type        = string
  default     = "registry/artifacts/dev"
}

variable "tessera_tiles_prefix" {
  description = "Prefix for Tessera tiles/checkpoints."
  type        = string
  default     = "tessera/tiles/dev"
}

variable "tessera_requests_prefix" {
  description = "Prefix for Tessera append-intent/request objects."
  type        = string
  default     = "tessera/requests/dev"
}

variable "allowed_read_principal_arns" {
  description = "Optional read principals for the shared bucket."
  type        = list(string)
  default     = []
}

variable "allowed_write_principal_arns" {
  description = "Optional write principals for the shared bucket."
  type        = list(string)
  default     = []
}

variable "create_ssm_config_parameters" {
  description = "Whether to publish S3 config into SSM Parameter Store."
  type        = bool
  default     = true
}

variable "ssm_parameter_prefix" {
  description = "SSM parameter prefix used for the bucket outputs."
  type        = string
  default     = "/agents-registry/dev"
}

variable "force_destroy" {
  description = "Allow Terraform to destroy the bucket even when it contains objects."
  type        = bool
  default     = false
}
