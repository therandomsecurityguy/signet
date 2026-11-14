# ---- Alerting ---------------------------------------------------------------
# CloudWatch alarms for the data plane plus optional external HTTPS health
# checks (Route53) for public endpoints. All alerts fan out to one SNS topic;
# add recipients via var.alert_email_subscriptions (each receives a
# confirmation email before it starts receiving).
#
# Covered here: RDS capacity/memory/storage/connections, ElastiCache
# (per cluster member, so failover does not blind the metrics), and external
# /healthz-style endpoints. In-cluster pod health (e.g. the tessera-sidecar
# publish dependency) needs a scraper or watchdog and is tracked separately.

resource "aws_sns_topic" "alerts" {
  name = "${var.project_name}-${var.environment}-alerts"

  # SSE with the AWS-managed SNS key: encrypts at rest without extra
  # key-policy grants. Switching to the module CMK requires an explicit key
  # policy for the CloudWatch service principal (alarms publish to this
  # topic as cloudwatch.amazonaws.com).
  kms_master_key_id = "alias/aws/sns"

  tags = merge(local.common_tags, { Component = "alerts" })
}

resource "aws_sns_topic_subscription" "alerts_email" {
  for_each = toset(var.alert_email_subscriptions)

  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = each.value
}

locals {
  alarm_actions = [aws_sns_topic.alerts.arn]

  # name => url -> host/path parts for Route53 health checks.
  health_check_parts = {
    for name, url in var.health_checks : name => split("/", replace(url, "https://", ""))
  }
}

# ---- RDS --------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "db_cpu" {
  alarm_name          = "${var.project_name}-${var.environment}-db-cpu-high"
  alarm_description   = "Postgres CPU utilization sustained above the threshold."
  namespace           = "AWS/RDS"
  metric_name         = "CPUUtilization"
  dimensions          = { DBInstanceIdentifier = aws_db_instance.this.identifier }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = var.db_cpu_alarm_threshold_percent
  comparison_operator = "GreaterThanThreshold"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
  tags                = merge(local.common_tags, { Component = "alerts" })
}

resource "aws_cloudwatch_metric_alarm" "db_free_memory" {
  alarm_name          = "${var.project_name}-${var.environment}-db-free-memory-low"
  alarm_description   = "Postgres freeable memory below the threshold."
  namespace           = "AWS/RDS"
  metric_name         = "FreeableMemory"
  dimensions          = { DBInstanceIdentifier = aws_db_instance.this.identifier }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 2
  threshold           = var.db_free_memory_alarm_bytes
  comparison_operator = "LessThanThreshold"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
  tags                = merge(local.common_tags, { Component = "alerts" })
}

resource "aws_cloudwatch_metric_alarm" "db_free_storage" {
  alarm_name          = "${var.project_name}-${var.environment}-db-free-storage-low"
  alarm_description   = "Postgres free storage space below the threshold."
  namespace           = "AWS/RDS"
  metric_name         = "FreeStorageSpace"
  dimensions          = { DBInstanceIdentifier = aws_db_instance.this.identifier }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 1
  threshold           = var.db_free_storage_alarm_bytes
  comparison_operator = "LessThanThreshold"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
  tags                = merge(local.common_tags, { Component = "alerts" })
}

resource "aws_cloudwatch_metric_alarm" "db_connections" {
  alarm_name          = "${var.project_name}-${var.environment}-db-connections-high"
  alarm_description   = "Postgres connection count above the threshold."
  namespace           = "AWS/RDS"
  metric_name         = "DatabaseConnections"
  dimensions          = { DBInstanceIdentifier = aws_db_instance.this.identifier }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 2
  threshold           = var.db_connections_alarm_threshold
  comparison_operator = "GreaterThanThreshold"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
  tags                = merge(local.common_tags, { Component = "alerts" })
}

# ---- ElastiCache ------------------------------------------------------------
# Alarms are created per replication-group member so a failover toward the
# secondary does not silently blind the metrics.

resource "aws_cloudwatch_metric_alarm" "redis_cpu" {
  for_each = toset(aws_elasticache_replication_group.this.member_clusters)

  alarm_name          = "${var.project_name}-${var.environment}-redis-cpu-high-${each.value}"
  alarm_description   = "Redis CPU utilization sustained above the threshold (${each.value})."
  namespace           = "AWS/ElastiCache"
  metric_name         = "CPUUtilization"
  dimensions          = { CacheClusterId = each.value }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = var.redis_cpu_alarm_threshold_percent
  comparison_operator = "GreaterThanThreshold"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
  tags                = merge(local.common_tags, { Component = "alerts" })
}

resource "aws_cloudwatch_metric_alarm" "redis_free_memory" {
  for_each = toset(aws_elasticache_replication_group.this.member_clusters)

  alarm_name          = "${var.project_name}-${var.environment}-redis-free-memory-low-${each.value}"
  alarm_description   = "Redis freeable memory below the threshold (${each.value})."
  namespace           = "AWS/ElastiCache"
  metric_name         = "FreeableMemory"
  dimensions          = { CacheClusterId = each.value }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 2
  threshold           = var.redis_free_memory_alarm_bytes
  comparison_operator = "LessThanThreshold"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
  tags                = merge(local.common_tags, { Component = "alerts" })
}

resource "aws_cloudwatch_metric_alarm" "redis_connections" {
  for_each = toset(aws_elasticache_replication_group.this.member_clusters)

  alarm_name          = "${var.project_name}-${var.environment}-redis-connections-high-${each.value}"
  alarm_description   = "Redis connection count above the threshold (${each.value})."
  namespace           = "AWS/ElastiCache"
  metric_name         = "CurrConnections"
  dimensions          = { CacheClusterId = each.value }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 2
  threshold           = var.redis_connections_alarm_threshold
  comparison_operator = "GreaterThanThreshold"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
  tags                = merge(local.common_tags, { Component = "alerts" })
}

resource "aws_cloudwatch_metric_alarm" "redis_evictions" {
  for_each = toset(aws_elasticache_replication_group.this.member_clusters)

  alarm_name          = "${var.project_name}-${var.environment}-redis-evictions-${each.value}"
  alarm_description   = "Redis evictions observed (${each.value}); capacity or TTL regression."
  namespace           = "AWS/ElastiCache"
  metric_name         = "Evictions"
  dimensions          = { CacheClusterId = each.value }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
  tags                = merge(local.common_tags, { Component = "alerts" })
}

# ---- External HTTPS health checks -------------------------------------------

resource "aws_route53_health_check" "public" {
  for_each = local.health_check_parts

  fqdn              = each.value[0]
  port              = 443
  type              = "HTTPS"
  resource_path     = length(each.value) > 1 ? "/${join("/", slice(each.value, 1, length(each.value)))}" : "/"
  failure_threshold = 3
  request_interval  = 30
  tags              = merge(local.common_tags, { Component = "alerts", Name = "${var.project_name}-${var.environment}-${each.key}" })
}

# `missing` avoids false alarms while the first health datapoint lands;
# sustained gaps remain visible via the health check's own status UI.
resource "aws_cloudwatch_metric_alarm" "public_health" {
  for_each = aws_route53_health_check.public

  alarm_name          = "${var.project_name}-${var.environment}-health-${each.key}"
  alarm_description   = "External HTTPS health check failing for ${each.key} (${var.health_checks[each.key]})."
  namespace           = "AWS/Route53"
  metric_name         = "HealthCheckStatus"
  dimensions          = { HealthCheckId = each.value.id }
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "missing"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
  tags                = merge(local.common_tags, { Component = "alerts" })
}

# ---- Sidecar watchdog -------------------------------------------------------
# The watchdog CronJob (chart: sidecarWatchdog.enabled) probes the
# tessera-sidecar and publishes SidecarHealthy every 2 minutes. Missing data
# is breaching on purpose: a dead watchdog is itself an incident.

resource "aws_cloudwatch_metric_alarm" "sidecar_watchdog" {
  count = var.sidecar_watchdog_enabled ? 1 : 0

  alarm_name          = "${var.project_name}-${var.environment}-sidecar-unhealthy"
  alarm_description   = "The tessera-sidecar watchdog reports the sidecar unhealthy (or the watchdog itself stopped reporting); publishes hard-depend on this service."
  namespace           = var.sidecar_watchdog_metric_namespace
  metric_name         = "SidecarHealthy"
  statistic           = "Minimum"
  period              = 120
  evaluation_periods  = 2
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
  tags                = merge(local.common_tags, { Component = "alerts" })
}

# Daily Fuseki graph backup: missing data is breaching, so a failed or
# skipped backup day alarms within a day (RPO <= 24h).
resource "aws_cloudwatch_metric_alarm" "fuseki_backup" {
  count = var.fuseki_backup_enabled ? 1 : 0

  alarm_name          = "${var.project_name}-${var.environment}-fuseki-backup-missing"
  alarm_description   = "The daily Fuseki graph backup did not report success (or the CronJob stopped running)."
  namespace           = var.sidecar_watchdog_metric_namespace
  metric_name         = "FusekiBackupSuccess"
  statistic           = "Minimum"
  period              = 86400
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
  tags                = merge(local.common_tags, { Component = "alerts" })
}
