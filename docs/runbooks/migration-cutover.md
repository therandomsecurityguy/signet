# Signet — off-platform migration / cutover runbook

Operational steps to migrate Signet off the platform deploy pipeline onto the
tf-io-sec path (see the plan referenced from the PRs). Phases 1–2 (repo modules
+ tf-io-sec units) are already merged. This covers go-live.

Legend: **[gated]** = requires an operator with AWS credentials and/or a
`@togethercomputer/security` approval.

## 0. Apply the registry and data units — [gated]

The units are pinned to the `v0.1.1` tag in tf-io-sec:

- `aws/together-ai/security-prod/us-west-2/ecr/signet` (Class-1)
- `aws/together-ai/security-prod/us-west-2/eks/security-prod-us-west-2/signet-data` (Class-1)

On the tf-io-sec PR that changes them: get an approval, then a security member
comments `apply`. The apply leg applies each in-scope unit. Confirm outputs:

```bash
cd aws/together-ai/security-prod/us-west-2/ecr/signet
terragrunt output -json   # publish_role_arn, registry_host, repository_urls
cd ../eks/security-prod-us-west-2/signet-data
terragrunt output -json   # eso_role_arn, secret_prefix, artifact_bucket_name, db/redis endpoints
```

## 1. Set the signet repo variables — [gated]

From the `signet-registry` outputs (in the `togethercomputer/signet` repo):

```bash
gh variable set CACHET_AWS_ROLE_ARN --body "<publish_role_arn>"
gh variable set CACHET_AWS_REGION   --body "us-west-2"
# ECR repo names default to signet/api, signet/mcp, signet/webapp,
# signet/tessera-sidecar, and charts; override only if they differ.
```

## 2. Publish the release artifacts

The v0.1.1 `Release` run failed at Assume AWS role before step 1. Re-run publish:

```bash
gh workflow run Release -f version=v0.1.1
```

Verify the manifest on the release and that the chart exists:

```bash
gh release download v0.1.1 -p release-manifest.json -O - | jq .
helm show chart oci://<registry_host>/charts/signet --version 0.1.1
```

## 3. Seed operator secrets — [gated]

Only two secrets are operator-seeded (never in Terraform state). Use the
`secret_prefix` output (default `signet-prod/runtime`).

```bash
aws secretsmanager put-secret-value \
  --secret-id signet-prod/runtime/okta-client-secret \
  --secret-string "$(op read 'op://.../signet-okta-client-secret')"

# CRITICAL: must be byte-identical to the signer used by the deployment being
# migrated from. A different key breaks the transparency-log signature chain.
aws secretsmanager put-secret-value \
  --secret-id signet-prod/runtime/tessera-log-private-key \
  --secret-string file:///secure/path/tessera-log-key.pem
```

The remaining keys (`database-url`, `fuseki-admin-password`, `redis-url`) are
Terraform-generated. S3 access is IRSA — there are no `s3-*` keys.

## 4. Deploy signet-eks

Now that the chart is published, move the unit from the unplanned baseline to
`terragrunt-kube-units.txt` (PR reviewed), then apply it manually (kube applies
are manual until Argo CD migration, SEC-3016). Pin the component image digests
from `release-manifest.json` in the unit's `set_values` before applying.

Verify:

```bash
kubectl -n signet get deploy,statefulset,pods
kubectl -n signet get externalsecret signet
kubectl -n signet get secretstore signet-secretsmanager
kubectl -n signet get secret signet -o jsonpath='{.data}' | jq 'keys'
kubectl -n signet get ingress
```

## 5. Parallel run (new deployment alongside the existing one)

Use **separate** backing stores (new Fuseki PVC, RDS, Redis, S3 bucket, Tessera
bucket/DB) — the `signet-data` module provisions these. Verify against the new
deployment directly before touching DNS:

- Okta login flow (issuer/audience/groups unchanged; hostname unchanged)
- Swagger UI `/v1/docs`, MCP `registry.*` tools
- publish → validate → certify lifecycle op end-to-end
- `GET .../versions/:v/provenance`

## 6. Data migration

Snapshot the transparency log coordinates first (log ID, witness roots, latest
checkpoint) — the continuity proof for cutover.

1. **Fuseki** (registry graph): back up from the source deployment's Jena store
   and load into the new one; then compare graph counts and RDFC-1.0 canonical
   digests of publication graphs.
2. **Postgres**: `pg_dump` from source, restore into the new RDS; verify audit/auth rows.
3. **S3 CAS artifacts**: `aws s3 sync` source bucket → new bucket; spot-check that
   content-addressed digests resolve.
4. **Tessera**: copy the log bucket + DB; verify inclusion proofs replay, the
   latest checkpoint equals the pre-migration snapshot, witness quorum observes,
   and signature verification passes.
5. **Delta sync**: freeze or incrementally re-sync writes made during migration.

## 7. Cutover

Point the `signet.internal.example.com` ingress at the new deployment
(ALB swap; hostname unchanged). Re-run the §5 smoke suite. Keep the old
deployment warm.

## 8. Decommission (after a soak of ≥ 1 week)

- Remove the platform ApplicationSet entry and `platform.together.ai/aws-access`
  annotation; delete `platform-<env>/signet/*` secrets and platform ECR images
  (after retention).
- Migrate Grafana dashboards/alerts to the new ServiceMonitor path.
- IRSA least-privilege review, NetworkPolicy coverage, KMS rotation, deletion
  protection on RDS/S3.

## Rollback

The old deployment stays live and warm through the soak. If the new deployment
fails, point DNS back and stop. No data is deleted during migration
(non-destructive), so rollback is a DNS revert.

## Guardrails

- Never seed a secret value through Helm values or Terraform state.
- Never regenerate `tessera-log-private-key`.
- Keep chart/image versions pinned (tag or digest); never `latest`.
