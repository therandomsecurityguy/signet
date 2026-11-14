output "release_name" {
  description = "Helm release name."
  value       = helm_release.this.name
}

output "release_namespace" {
  description = "Namespace the release was installed into."
  value       = helm_release.this.namespace
}

output "release_version" {
  description = "Installed chart version."
  value       = helm_release.this.version
}

output "release_status" {
  description = "Helm release status."
  value       = helm_release.this.status
}
