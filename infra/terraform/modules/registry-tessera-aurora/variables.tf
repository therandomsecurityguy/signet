variable "cluster_identifier" {
  description = "Aurora cluster identifier."
  type        = string
}

variable "project_name" {
  description = "Project tag/name prefix."
  type        = string
  default     = "signet"
}

variable "environment" {
  description = "Environment label such as dev, staging, or prod."
  type        = string
  default     = "dev"
}

variable "aws_region" {
  description = "AWS region used by runtime env outputs."
  type        = string
}

variable "vpc_id" {
  description = "VPC ID that will host the Aurora cluster."
  type        = string
}

variable "subnet_ids" {
  description = "Private subnet IDs for the Aurora subnet group."
  type        = list(string)
}

variable "allowed_security_group_ids" {
  description = "Security groups allowed to connect to Aurora on the MySQL port."
  type        = list(string)
  default     = []
}

variable "allowed_cidr_blocks" {
  description = "CIDR blocks allowed to connect to Aurora on the MySQL port."
  type        = list(string)
  default     = []
}

variable "database_name" {
  description = "Logical database name for the Tessera runtime."
  type        = string
  default     = "tessera"
}

variable "master_username" {
  description = "Master username stored in the generated Secrets Manager secret."
  type        = string
  default     = "tessera"
}

variable "engine_version" {
  description = "Aurora MySQL engine version. Override with a region-supported version before apply if needed."
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
  description = "Number of Aurora instances to create. Use 1 for a minimal writer-only dev shape."
  type        = number
  default     = 1
}

variable "backup_retention_period" {
  description = "Aurora backup retention in days."
  type        = number
  default     = 7
}

variable "preferred_backup_window" {
  description = "Preferred UTC backup window."
  type        = string
  default     = "07:00-09:00"
}

variable "preferred_maintenance_window" {
  description = "Preferred UTC maintenance window."
  type        = string
  default     = "sun:09:00-sun:10:00"
}

variable "deletion_protection" {
  description = "Enable deletion protection on the Aurora cluster."
  type        = bool
  default     = false
}

variable "skip_final_snapshot" {
  description = "Skip the final snapshot when destroying the cluster. Prefer false outside dev/test."
  type        = bool
  default     = true
}

variable "kms_key_arn" {
  description = "Optional KMS key ARN for cluster and secret encryption."
  type        = string
  default     = null
}

variable "secret_name" {
  description = "Optional explicit Secrets Manager name. Defaults to /<project>/<environment>/tessera-db."
  type        = string
  default     = null
}

variable "tags" {
  description = "Additional tags to apply to created resources."
  type        = map(string)
  default     = {}
}
