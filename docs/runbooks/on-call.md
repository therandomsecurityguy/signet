# Cachet — On-call / incident response

What to do when a Cachet alert fires or the service looks unhealthy.

## Where to look

- **Grafana / Prometheus**: the `Cachet` dashboard — request rate, 5xx, latency,
  pod count, log errors. Workloads are scraped via ServiceMonitors rendered by
  the chart (`metrics.serviceMonitor.enabled`).
- **Logs**: structured pino logs per pod. Filter by `request_id`, `principal_id`,
  or `client_name`. Traces go to the OTLP collector when
  `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
- **Metrics**: each workload exposes `GET /metrics` (Prometheus format).

## Alerts (from the chart's PrometheusRule)

| Alert | Meaning | First checks |
|---|---|---|
| `CachetHighErrorRate` | 5xx share above the availability SLO for 5m | Pod restarts, Fuseki health, DB connectivity, recent deploy |
| `CachetHighLatencyP99` | p99 latency above SLO for 5m | Fuseki query latency, S3 latency, resource limits (CPU throttling) |

## Common failures

- **Pods crashlooping on boot** — usually a missing/empty secret. Check
  `kubectl -n cachet get externalsecret cachet` and that the keys exist in
  Secrets Manager under `cachet-<env>/runtime/*`. A missing `database-url` or
  `okta-client-secret` fails startup.
- **All requests 401/403** — Okta misconfiguration. Verify `OKTA_ISSUER`,
  `OKTA_AUDIENCE`, and that the auth-server issuer is reachable from the cluster.
  Confirm the user's groups include the expected `app_cachet_*` groups.
- **Reads work, writes fail** — `OKTA_ADMIN_GROUPS` mismatch, or the principal is a
  viewer. Check the audit log for `missing_admin_group` denials.
- **Fuseki unavailable** — the api/mcp `readyz` will flap. Check the `fuseki`
  StatefulSet pod and its PVC. Confirm NetworkPolicies still allow api/mcp/
  tessera-sidecar egress to Fuseki.
- **Artifact load failures** — S3 credentials or bucket. Verify the `s3-*` keys in
  the `cachet` Secret, the artifact IAM user policy, and the bucket.
- **ESO not syncing** — check the SecretStore (`kubectl -n cachet get secretstore
  cachet-secretsmanager`), the ServiceAccount IRSA annotation, and the
  `cachet-data` ESO role.

## Escalation

- Registry/domain correctness issues → Cachet owners.
- Secrets/ESO/IRSA/network issues → the `cachet-data` Terraform module owner in
  `tf-io-sec`.
- Okta app/group issues → tf-io-sec (`okta/.../apps/cachet`).
