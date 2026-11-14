variable "namespace" {
  description = "Kubernetes namespace to deploy into."
  type        = string
  default     = "cachet"
}

variable "create_namespace" {
  description = "Create the namespace. Prefer false when the environment repo (tf-io-sec) owns the namespace."
  type        = bool
  default     = false
}

variable "release_name" {
  description = "Helm release name."
  type        = string
  default     = "cachet"
}

variable "chart_repository" {
  description = "OCI repository for the published chart, e.g. oci://<acct>.dkr.ecr.us-west-2.amazonaws.com/charts."
  type        = string
}

variable "chart_name" {
  description = "Chart name."
  type        = string
  default     = "cachet"
}

variable "chart_version" {
  description = "Pinned chart version (must match the app image tag)."
  type        = string
}

variable "values_files" {
  description = "Ordered list of values YAML files (later files override earlier)."
  type        = list(string)
  default     = []
}

variable "set_values" {
  description = "Map of additional Helm --set values."
  type        = map(string)
  default     = {}
}

variable "timeout_seconds" {
  description = "Helm install/upgrade timeout in seconds."
  type        = number
  default     = 600
}

variable "wait" {
  description = "Wait for resources to be ready before returning."
  type        = bool
  default     = true
}

variable "atomic" {
  description = "Roll back on failure."
  type        = bool
  default     = true
}
