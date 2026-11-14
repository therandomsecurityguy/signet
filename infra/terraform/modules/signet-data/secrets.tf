# One Secrets Manager secret container per key, named <prefix>/<key> to match
# the chart's ExternalSecret remoteRef paths.
resource "aws_secretsmanager_secret" "this" {
  for_each = toset(local.all_secret_keys)

  name                    = "${local.secret_prefix}/${each.value}"
  recovery_window_in_days = var.secret_recovery_window_in_days
  kms_key_id              = aws_kms_key.this.arn

  tags = merge(local.common_tags, { Component = "secrets" })
}

# Generated values. Operator-seeded keys (okta-client-secret,
# tessera-log-private-key) intentionally have no version here — seed them with
# `aws secretsmanager put-secret-value` so they never transit Terraform state.
locals {
  generated_secret_values = {
    "database-url"          = "postgresql://${var.db_username}:${urlencode(random_password.db.result)}@${aws_db_instance.this.address}:${aws_db_instance.this.port}/${var.db_name}?sslmode=require"
    "fuseki-admin-password" = random_password.fuseki.result
    "redis-url"             = "rediss://:${urlencode(random_password.redis.result)}@${aws_elasticache_replication_group.this.primary_endpoint_address}:${aws_elasticache_replication_group.this.port}"
    "api-key-pepper"        = random_password.api_key_pepper.result
  }
}

resource "aws_secretsmanager_secret_version" "generated" {
  for_each = local.generated_secret_values

  secret_id     = aws_secretsmanager_secret.this[each.key].id
  secret_string = each.value
}
