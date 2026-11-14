variable "project_name" {
  description = "Project tag/name prefix."
  type        = string
  default     = "cachet"
}

variable "environment" {
  description = "Environment label such as dev, staging, or prod."
  type        = string
}

variable "components" {
  description = "Component image repositories to create (immutable, scan-on-push)."
  type        = list(string)
  default     = ["api", "mcp", "webapp", "tessera-sidecar"]
}

variable "chart_repository_name" {
  description = "OCI repository name for the published Helm chart (empty disables it). helm push to oci://<registry>/charts appends the chart name, so this must be the full path (e.g. charts/cachet)."
  type        = string
  default     = "charts/cachet"
}

variable "github_repository" {
  description = "GitHub repository allowed to assume the publish role, as owner/name."
  type        = string
}

variable "github_workflow" {
  description = "GitHub Actions workflow name allowed to assume the publish role."
  type        = string
  default     = "Release"
}

variable "github_refs" {
  description = "StringLike pattern for the token ref claim (e.g. refs/tags/v*)."
  type        = string
  default     = "refs/tags/v*"
}

variable "github_subjects" {
  description = "StringLike pattern for the token sub claim (e.g. repo:owner/name:ref:refs/tags/*)."
  type        = string
}

variable "create_openid_provider" {
  description = "Create the GitHub OIDC provider. Set false to use an account-level provider that already exists."
  type        = bool
  default     = false
}

variable "github_oidc_provider_arn" {
  description = "Existing GitHub OIDC provider ARN. When set, the provider is not looked up by URL."
  type        = string
  default     = null
}

variable "publish_role_name" {
  description = "Name of the IAM role GitHub Actions assumes. Empty derives project-environment-github-publish."
  type        = string
  default     = ""
}

variable "force_delete" {
  description = "Allow Terraform to delete repositories even when they contain images. Prefer false outside dev/test."
  type        = bool
  default     = false
}

variable "tags" {
  description = "Additional tags applied to every resource."
  type        = map(string)
  default     = {}
}

variable "reader_github_repository" {
  description = "GitHub repository allowed to assume the read-only role, as owner/name. Empty disables the role."
  type        = string
  default     = ""
}

variable "reader_github_workflow" {
  description = "GitHub Actions workflow name allowed to assume the read-only role. Empty allows any workflow in the repository."
  type        = string
  default     = ""
}

variable "reader_github_refs" {
  description = "StringLike pattern for the token ref claim for the read-only role."
  type        = string
  default     = "refs/heads/main"
}

variable "reader_github_subjects" {
  description = "StringLike pattern for the token sub claim for the read-only role (e.g. repo:owner@id/name@id:ref:refs/heads/main). Required when reader_github_repository is set."
  type        = string
  default     = ""
}

variable "reader_role_name" {
  description = "Name of the read-only IAM role. Empty derives project-environment-github-read."
  type        = string
  default     = ""
}
