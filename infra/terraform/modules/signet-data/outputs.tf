output "kms_key_arn" {
  description = "CMK ARN used for secrets, S3, RDS and Redis encryption."
  value       = aws_kms_key.this.arn
}

output "secret_prefix" {
  description = "Secrets Manager path prefix (set as the chart's secrets.external.prefix)."
  value       = local.secret_prefix
}

output "secret_arns" {
  description = "Map of secret key to Secrets Manager ARN."
  value       = { for key, s in aws_secretsmanager_secret.this : key => s.arn }
}

output "operator_secret_keys" {
  description = "Secret keys that must be seeded by an operator (no Terraform-managed version)."
  value       = local.operator_secret_keys
}

output "artifact_bucket_name" {
  description = "Artifact bucket name (set as the chart's artifacts.s3.bucket)."
  value       = aws_s3_bucket.artifacts.id
}

output "artifact_bucket_arn" {
  description = "Artifact bucket ARN."
  value       = aws_s3_bucket.artifacts.arn
}

output "database_endpoint" {
  description = "Postgres endpoint (host:port)."
  value       = "${aws_db_instance.this.address}:${aws_db_instance.this.port}"
}

output "redis_endpoint" {
  description = "Redis primary endpoint (host:port)."
  value       = "${aws_elasticache_replication_group.this.primary_endpoint_address}:${aws_elasticache_replication_group.this.port}"
}

output "eso_role_arn" {
  description = "IRSA role ARN for External Secrets Operator and artifact-bucket access (set as the chart's serviceAccount.roleArn)."
  value       = aws_iam_role.eso.arn
}

output "alerts_topic_arn" {
  description = "SNS topic ARN that data-plane and health alarms publish to."
  value       = aws_sns_topic.alerts.arn
}
