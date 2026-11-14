output "cluster_endpoint" {
  description = "Writer endpoint for the Aurora cluster."
  value       = aws_rds_cluster.this.endpoint
}

output "reader_endpoint" {
  description = "Reader endpoint for the Aurora cluster."
  value       = aws_rds_cluster.this.reader_endpoint
}

output "port" {
  description = "Aurora MySQL port."
  value       = aws_rds_cluster.this.port
}

output "database_name" {
  description = "Database name configured for the Tessera runtime."
  value       = var.database_name
}

output "master_username" {
  description = "Master username stored in the secret payload."
  value       = var.master_username
}

output "security_group_id" {
  description = "Security group ID attached to the Aurora cluster."
  value       = aws_security_group.this.id
}

output "secret_arn" {
  description = "Secrets Manager ARN containing the Tessera runtime DB connection."
  value       = aws_secretsmanager_secret.db.arn
}

output "secret_name" {
  description = "Secrets Manager name containing the Tessera runtime DB connection."
  value       = aws_secretsmanager_secret.db.name
}

output "tessera_runtime_db_env" {
  description = "Copy/paste environment block for the Tessera runtime DB configuration."
  sensitive   = true
  value = join("\n", [
    "TESSERA_AWS_REGION=${var.aws_region}",
    "TESSERA_DB_SECRET_ARN=${aws_secretsmanager_secret.db.arn}",
  ])
}
