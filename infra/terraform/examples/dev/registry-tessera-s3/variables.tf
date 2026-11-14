variable "aws_region" {
  type    = string
  default = "us-west-2"
}

variable "environment" {
  type    = string
  default = "dev"
}

variable "bucket_name" {
  type = string
}

variable "force_destroy" {
  type    = bool
  default = false
}

variable "kms_key_arn" {
  type    = string
  default = null
}

variable "registry_artifact_prefix" {
  type    = string
  default = "registry/artifacts/dev"
}

variable "tessera_tiles_prefix" {
  type    = string
  default = "tessera/tiles/dev"
}

variable "tessera_requests_prefix" {
  type    = string
  default = "tessera/requests/dev"
}

variable "allowed_read_principal_arns" {
  type    = list(string)
  default = []
}

variable "allowed_write_principal_arns" {
  type    = list(string)
  default = []
}

variable "create_ssm_config_parameters" {
  type    = bool
  default = true
}

variable "ssm_parameter_prefix" {
  type    = string
  default = "/agents-registry/dev"
}
