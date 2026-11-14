# Alerting

Signet alerts fan out through the `signet-<env>-alerts` SNS topic (created by
the `signet-data` Terraform module). Email subscribers must confirm the SNS
confirmation email once — **an unconfirmed subscription silently receives
nothing** (`aws sns list-subscriptions-by-topic` shows `PendingConfirmation`).

## What alerts exist

| Alarm | Signal | First response |
|---|---|---|
| `*-db-cpu-high` | RDS CPU > 80% (3×5m) | Check slow queries / connection storms; scale instance if sustained. |
| `*-db-free-memory-low` | RDS freeable memory < 256 MiB (2×5m) | Look for connection leaks / heavy report queries. |
| `*-db-free-storage-low` | RDS free storage < 5 GiB | Confirm autoscaling/grow storage; check WAL/table bloat. |
| `*-db-connections-high` | RDS connections > 80 (2×5m) | Look for leaked pools (api/mcp) or a runaway client. |
| `*-redis-cpu-high-*` / `*-redis-free-memory-low-*` / `*-redis-connections-high-*` | Per ElastiCache member (failover-safe) | Check query cache pressure from api/mcp; scale node class. |
| `*-redis-evictions-*` | Any evictions in 5m | Cache is undersized or keys lack TTLs; treat as a defect. |
| `*-health-api` / `*-health-openapi` | Route53 HTTPS checks against `https://signet.example.com/healthz` and `/v1/openapi.json`, 3 failures @30s | User path is down: check tunnel, ingress, api pods. |
| `*-sidecar-unhealthy` | `Signet/Watchdog/SidecarHealthy` minimum < 1 (2×120s) or **missing data** | Publishes hard-depend on the sidecar — see `sidecar-degraded-mode.md`. |
| `*-fuseki-backup-missing` | `Signet/Watchdog/FusekiBackupSuccess` minimum < 1 daily, or **missing data** | The daily Fuseki graph dump did not run or failed — check the `fuseki-backup` CronJob logs. See "Restore" notes in this runbook. |

Alarms publish to SNS on both ALARM and OK transitions, so recovery is
visible too.

## Verify the pipeline after an apply

```bash
aws cloudwatch describe-alarms --alarm-name-prefix signet-<env> \
  --query 'MetricAlarms[].[AlarmName,StateValue]' --output text
aws sns list-subscriptions-by-topic --topic-arn <topic-arn> \
  --query 'Subscriptions[].[Endpoint,SubscriptionArn]' --output text   # ARN, not PendingConfirmation
```

## The watchdog (dead-man's switch)

The `sidecar-watchdog` CronJob (chart: `sidecarWatchdog.enabled`) probes the
sidecar's `/healthz` + `/v1/config` every 2 minutes and publishes
`Signet/Watchdog/SidecarHealthy` (1 = healthy). The alarm treats **missing
data as breaching**, so a stopped CronJob, RBAC break, or crash also alerts —
do not "fix" a false alarm by relaxing `treat_missing_data`.

Quick manual check of the same probe:

```bash
kubectl -n signet get jobs | grep sidecar-watchdog
kubectl -n signet logs job/<watchdog-job> | tail -1   # {"healthy":true,...}
```

## Known pitfalls

- SNS **does not retry** subscription confirmation emails. If the address
  never receives one (quarantine/plus-addressing/groups), swap the endpoint
  in `signet-data`'s `alert_email_subscriptions` and apply — that recreates
  the subscription and re-sends confirmation.
- Route53 health-check alarms use `treat_missing_data = missing` to avoid
  false alarms while first datapoints land; the health check's own console
  view shows gaps.
