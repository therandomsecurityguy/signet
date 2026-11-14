variable "aws_region" {
  description = "AWS region."
  type        = string
  default     = "us-west-2"
}

variable "environment" {
  description = "Environment label."
  type        = string
  default     = "dev"
}

variable "namespace" {
  description = "Kubernetes namespace for the cachet release."
  type        = string
  default     = "cachet"
}

variable "chart_version" {
  description = "Pinned cachet chart version."
  type        = string
}

variable "values_file" {
  description = "Path to the per-env chart values file."
  type        = string
}

variable "github_repository" {
  description = "GitHub repository allowed to publish (owner/name)."
  type        = string
}

variable "github_subjects" {
  description = "StringLike pattern for the GitHub OIDC sub claim."
  type        = string
}

variable "vpc_id" {
  description = "VPC id for the data plane."
  type        = string
}

variable "private_subnet_ids" {
  description = "Private subnet ids for RDS/Redis."
  type        = list(string)
}

variable "allowed_security_group_ids" {
  description = "Security group ids allowed to reach Postgres/Redis."
  type        = list(string)
  default     = []
}

variable "allowed_cidr_blocks" {
  description = "CIDRs allowed to reach Postgres/Redis."
  type        = list(string)
  default     = []
}

variable "artifact_bucket_name" {
  description = "S3 bucket name for registry CAS artifacts."
  type        = string
}

variable "eks_oidc_provider_arn" {
  description = "EKS cluster OIDC provider ARN."
  type        = string
}

variable "db_multi_az" {
  type    = bool
  default = false
}

variable "db_deletion_protection" {
  type    = bool
  default = true
}

variable "redis_num_cache_clusters" {
  type    = number
  default = 1
}

variable "redis_multi_az" {
  type    = bool
  default = false
}

variable "secret_recovery_window_in_days" {
  type    = number
  default = 7
}

variable "tags" {
  type    = map(string)
  default = {}
}
