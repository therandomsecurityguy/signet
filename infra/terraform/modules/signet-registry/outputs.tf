output "repository_urls" {
  description = "Map of component name to ECR repository URL."
  value       = { for key, repo in aws_ecr_repository.images : key => repo.repository_url }
}

output "repository_arns" {
  description = "List of ECR repository ARNs."
  value       = local.all_repository_arns
}

output "registry_host" {
  description = "ECR registry host for the account/region (use as the chart's image.registry)."
  value       = "${local.account_id}.dkr.ecr.${data.aws_region.current.region}.amazonaws.com"
}

output "publish_role_arn" {
  description = "IAM role ARN for GitHub Actions OIDC publishing (set as the AWS_ROLE_ARN repo variable)."
  value       = aws_iam_role.github_actions_publish.arn
}

output "chart_repository_url" {
  description = "ECR repository URL for the Helm chart OCI artifact, if enabled."
  value       = try(aws_ecr_repository.images["chart"].repository_url, null)
}

output "reader_role_arn" {
  description = "IAM role ARN for read-only CI access (cosign verification from other repos/workflows). Empty when disabled."
  value       = try(aws_iam_role.github_actions_read[0].arn, "")
}
