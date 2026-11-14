variable "project_name" {
  description = "Project tag/name prefix."
  type        = string
  default     = "signet"
}

variable "environment" {
  description = "Environment label such as dev, staging, or prod."
  type        = string
}

variable "region" {
  description = "AWS region. Used to build resource ARNs and endpoints."
  type        = string
  default     = "us-west-2"
}

variable "tags" {
  description = "Additional tags applied to every resource."
  type        = map(string)
  default     = {}
}

# ---- Networking -------------------------------------------------------------

variable "vpc_id" {
  description = "VPC the data plane lives in."
  type        = string
}

variable "private_subnet_ids" {
  description = "Private subnet IDs for the RDS subnet group and ElastiCache subnet group."
  type        = list(string)
}

variable "allowed_security_group_ids" {
  description = "Security group IDs (e.g. the EKS node/ pod SG) allowed to reach Postgres and Redis."
  type        = list(string)
  default     = []
}

variable "allowed_cidr_blocks" {
  description = "CIDR blocks allowed to reach Postgres and Redis (use sparingly)."
  type        = list(string)
  default     = []
}

# ---- Artifacts (S3) ---------------------------------------------------------

variable "artifact_bucket_name" {
  description = "Name of the S3 bucket for registry CAS artifacts."
  type        = string
}

variable "artifact_prefix" {
  description = "Key prefix inside the artifact bucket."
  type        = string
  default     = "signet"
}

variable "force_destroy_bucket" {
  description = "Allow Terraform to destroy the artifact bucket even when non-empty. Prefer false outside dev/test."
  type        = bool
  default     = false
}

# ---- Postgres ---------------------------------------------------------------

variable "db_name" {
  description = "Initial database name."
  type        = string
  default     = "signet"
}

variable "db_username" {
  description = "Master username."
  type        = string
  default     = "signet"
}

variable "db_instance_class" {
  description = "RDS instance class."
  type        = string
  default     = "db.t4g.micro"
}

variable "db_engine_version" {
  description = "Postgres engine version. RDS drops old minors for creation over time, so callers should pin a currently-available minor."
  type        = string
  default     = "16.15"
}

variable "db_allocated_storage" {
  description = "Allocated storage in GiB."
  type        = number
  default     = 20
}

variable "db_multi_az" {
  description = "Enable a Multi-AZ standby. Recommended for prod."
  type        = bool
  default     = false
}

variable "db_backup_retention_period" {
  description = "Automated backup retention in days."
  type        = number
  default     = 7
}

variable "db_deletion_protection" {
  description = "Enable deletion protection. Recommended for prod."
  type        = bool
  default     = true
}

variable "db_auto_minor_version_upgrade" {
  description = "Automatically apply minor engine upgrades during the maintenance window."
  type        = bool
  default     = true
}

# ---- Redis ------------------------------------------------------------------

variable "redis_node_type" {
  description = "ElastiCache node type."
  type        = string
  default     = "cache.t4g.micro"
}

variable "redis_engine_version" {
  description = "Redis engine version."
  type        = string
  default     = "7.1"
}

variable "redis_num_cache_clusters" {
  description = "Number of cache clusters (nodes). Use 2+ with automatic failover for prod."
  type        = number
  default     = 1
}

variable "redis_multi_az" {
  description = "Enable Multi-AZ for the replication group."
  type        = bool
  default     = false
}

# ---- Secrets ----------------------------------------------------------------

variable "secret_prefix" {
  description = "AWS Secrets Manager path prefix. Empty derives signet-<env>/runtime."
  type        = string
  default     = ""
}

variable "secret_recovery_window_in_days" {
  description = "Recovery window for deleted secrets. Use 0 in dev/test to allow immediate recreation."
  type        = number
  default     = 7
}

variable "additional_secret_keys" {
  description = "Extra secret containers to create under the prefix (operator-seeded, e.g. future keys)."
  type        = list(string)
  default     = []
}

# ---- EKS IRSA ---------------------------------------------------------------

variable "eks_oidc_provider_arn" {
  description = "EKS cluster OIDC provider ARN, used to build IRSA trust policies."
  type        = string
}

variable "eks_oidc_issuer_url" {
  description = "EKS cluster OIDC issuer URL. Empty derives it from the provider ARN."
  type        = string
  default     = ""
}

variable "eso_namespace" {
  description = "Namespace of the External Secrets Operator service account."
  type        = string
  default     = "signet"
}

variable "eso_service_account_name" {
  description = "Service account name used by the rendered SecretStore and by registry workloads (chart serviceAccount.name)."
  type        = string
  default     = "signet"
}

# ---- Alerting ---------------------------------------------------------------

variable "alert_email_subscriptions" {
  description = "Email addresses subscribed to the alerts SNS topic. Each address receives a confirmation email before it starts receiving alerts."
  type        = list(string)
  default     = []
}

variable "health_checks" {
  description = "External HTTPS endpoints monitored via Route53 health checks, as name => full URL (e.g. { api = \"https://signet.example.com/healthz\" }). Empty disables them."
  type        = map(string)
  default     = {}
}

variable "db_cpu_alarm_threshold_percent" {
  description = "Alarm when RDS CPUUtilization exceeds this percentage."
  type        = number
  default     = 80
}

variable "db_free_memory_alarm_bytes" {
  description = "Alarm when RDS FreeableMemory drops below this many bytes."
  type        = number
  default     = 268435456 # 256 MiB
}

variable "db_free_storage_alarm_bytes" {
  description = "Alarm when RDS FreeStorageSpace drops below this many bytes."
  type        = number
  default     = 5368709120 # 5 GiB
}

variable "db_connections_alarm_threshold" {
  description = "Alarm when RDS DatabaseConnections exceeds this count."
  type        = number
  default     = 80
}

variable "redis_cpu_alarm_threshold_percent" {
  description = "Alarm when ElastiCache CPUUtilization exceeds this percentage."
  type        = number
  default     = 80
}

variable "redis_free_memory_alarm_bytes" {
  description = "Alarm when ElastiCache FreeableMemory drops below this many bytes."
  type        = number
  default     = 134217728 # 128 MiB
}

variable "redis_connections_alarm_threshold" {
  description = "Alarm when ElastiCache CurrConnections exceeds this count."
  type        = number
  default     = 500
}

variable "sidecar_watchdog_enabled" {
  description = "Create the alarm for the tessera-sidecar watchdog metric. Enable together with the chart's sidecarWatchdog.enabled."
  type        = bool
  default     = false
}

variable "sidecar_watchdog_metric_namespace" {
  description = "CloudWatch namespace the sidecar watchdog publishes to."
  type        = string
  default     = "Signet/Watchdog"
}

variable "fuseki_backup_enabled" {
  description = "Create the alarm for the daily Fuseki backup metric. Enable together with the chart's fusekiBackup.enabled."
  type        = bool
  default     = false
}
