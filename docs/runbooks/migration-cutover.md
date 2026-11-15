# Signet — deployment cutover runbook

Operational steps to move Signet from an existing deployment to a new
environment (new account/cluster, or a first production rollout) with minimal
disruption. Assumes the `signet-registry` and `signet-data` modules have been
applied in the new environment and the release workflow is configured.

Legend: **[gated]** = requires an operator with cloud credentials and/or
change-management approval.

## 0. Apply the registry and data modules — [gated]

Apply `infra/terraform/modules/signet-registry` (ECR + GitHub OIDC publish
role) and `infra/terraform/modules/signet-data` (KMS, Secrets Manager, S3,
RDS, Redis, IRSA) in the new environment, then confirm outputs:

```bash
terraform -chdir=<env>/registry output -json   # publish_role_arn, registry_host, repository_urls
terraform -chdir=<env>/data output -json       # eso_role_arn, secret_prefix, artifact_bucket_name, db/redis endpoints
```

## 1. Repo variables — none required

Publishing to GHCR needs no repo variables (the workflow uses its
`GITHUB_TOKEN`). Only set these if you mirror the pipeline to a different
registry layout:

```bash
gh variable set SIGNET_IMAGE_NAMESPACE  --body "<owner-or-namespace>"
gh variable set SIGNET_CHART_REPOSITORY --body "charts"
```

## 2. Publish the release artifacts

Run the `Release` workflow for the target version and verify the manifest and
chart exist:

```bash
gh workflow run Release -f version=v<version>
gh release download v<version> -p release-manifest.json -O - | jq .
helm show chart oci://<registry_host>/charts/signet --version <version>
```

## 3. Seed operator secrets — [gated]

Only secrets that cannot be generated are operator-seeded (never in Terraform
state). Use the `secret_prefix` output (default `signet-<env>/runtime`).

```bash
aws secretsmanager put-secret-value \
  --secret-id signet-<env>/runtime/oidc-client-secret \
  --secret-string "$(cat /secure/path/signet-oidc-client-secret)"

# CRITICAL: if migrating an existing transparency log, this must be
# byte-identical to the signer of the deployment being migrated from.
# A different key breaks the transparency-log signature chain.
aws secretsmanager put-secret-value \
  --secret-id signet-<env>/runtime/tessera-log-private-key \
  --secret-string file:///secure/path/tessera-log-key.pem
```

The remaining keys (`database-url`, `fuseki-admin-password`, `redis-url`) are
Terraform-generated. S3 access is IRSA — there are no `s3-*` keys.

## 4. Deploy the chart

Pin the component image digests from `release-manifest.json` in your
environment values and apply the `signet-eks` module (or `helm upgrade`
directly in a non-production environment).

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

- OIDC login flow (issuer/audience/groups as configured)
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

Point the deployment's ingress/DNS at the new environment. Re-run the §5 smoke
suite. Keep the old deployment warm.

## 8. Decommission (after a soak of ≥ 1 week)

- Remove the old platform's app entry/annotations and old secrets/images
  (after retention).
- Migrate dashboards/alerts to the new ServiceMonitor path.
- IRSA least-privilege review, NetworkPolicy coverage, KMS rotation, deletion
  protection on RDS/S3.

## Rollback

The old deployment stays live and warm through the soak. If the new deployment
fails, point DNS back and stop. No data is deleted during migration
(non-destructive), so rollback is a DNS revert.

## Guardrails

- Never seed a secret value through Helm values or Terraform state.
- Never regenerate `tessera-log-private-key` while migrating an existing log.
- Keep chart/image versions pinned (tag or digest); never `latest`.
