variable "bucket_name" {
  description = "Name of the shared S3 bucket for registry artifacts and Tessera companion data."
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

variable "force_destroy" {
  description = "Allow Terraform to destroy the bucket even when it still contains objects. Prefer false outside dev/test."
  type        = bool
  default     = false
}

variable "kms_key_arn" {
  description = "Optional KMS key ARN for bucket default encryption. When omitted, SSE-S3 (AES256) is used."
  type        = string
  default     = null
}

variable "registry_artifact_prefix" {
  description = "Prefix used by the registry S3 CAS."
  type        = string
  default     = "registry/artifacts/dev"
}

variable "tessera_tiles_prefix" {
  description = "Prefix reserved for Tessera tile/checkpoint data."
  type        = string
  default     = "tessera/tiles/dev"
}

variable "tessera_requests_prefix" {
  description = "Prefix reserved for sidecar append-intent/request objects."
  type        = string
  default     = "tessera/requests/dev"
}

variable "allowed_read_principal_arns" {
  description = "Optional principal ARNs allowed to read registry and Tessera objects."
  type        = list(string)
  default     = []
}

variable "allowed_write_principal_arns" {
  description = "Optional principal ARNs allowed to write registry artifacts or Tessera request/tile data."
  type        = list(string)
  default     = []
}

variable "create_ssm_config_parameters" {
  description = "Whether to publish bucket/prefix configuration into SSM Parameter Store so operators can reference it indirectly."
  type        = bool
  default     = true
}

variable "ssm_parameter_prefix" {
  description = "SSM parameter prefix used when create_ssm_config_parameters is true."
  type        = string
  default     = "/signet/dev"
}

variable "tags" {
  description = "Additional tags to apply to created resources."
  type        = map(string)
  default     = {}
}
