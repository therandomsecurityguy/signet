# Signet — Deploy runbook

How Signet is deployed and what to check when it isn't. Signet follows the
**two-repo rule**: this repo ships release-tagged artifacts; the environment repo
that owns Terraform state and applies them.

> Migrating off the legacy platform pipeline? See
> [`migration-cutover.md`](./migration-cutover.md).

## Topology

- This repo publishes on release: immutable, digest-pinned component images and
  the Helm chart to **GHCR** (`.github/workflows/release.yaml`) under
  `ghcr.io/<owner>/signet/…`, authenticated with the workflow's `GITHUB_TOKEN`
  — no cloud account, no static credentials, no shared reusable workflow.
- The environment repo pins the released chart version and applies the `signet-eks`
  Terraform module (which calls `helm_release`) into the `signet` namespace.
- Workloads: `api`, `mcp`, `webapp`, `tessera-sidecar` (Deployments) + `fuseki`
  (StatefulSet). Backing stores: RDS Postgres, ElastiCache Redis, S3 artifacts,
  Secrets Manager — all provisioned by the `signet-data` module.
- Chart source: `charts/signet`. Terraform modules: `infra/terraform/modules/signet-{registry,data,eks}`.

## Configuration

- Non-secret per-env values: `charts/signet/values-<env>.yaml`
  (`image.registry`, `auth.okta*`, `artifacts.s3.bucket`, `serviceAccount.roleArn`,
  `secrets.external.prefix`, `networkPolicies.egressCidrs`).
- CAS read integrity: `artifacts.integrityMode` (`warn` default, `enforce` to
  fail reads on a digest mismatch). Start on `warn`, review findings, then
  move prod to `enforce`.
- MCP read gates: `mcp.readGates.denyRevoked` (**true by default**: revoked
  publications are refused on the MCP read path; set false only for legacy
  fail-open) and `mcp.readGates.requireVerified` (opt-in: also refuse
  publications that do not verify). Denials surface as
  `REGISTRY_READ_DENIED_REVOKED` / `REGISTRY_READ_DENIED_UNVERIFIED`;
  verification itself is never gated.
- Postgres TLS: `DATABASE_URL` accepts `postgres://`/`postgresql://` (RDS) or
  `file:` (SQLite, local dev). The RDS instance chains to a **regional** CA
  (`Amazon RDS us-west-2 Root CA RSA2048 G1`) that public trust stores do not
  know, so verified TLS needs the region bundle: set
  `database.sslRootCert.enabled: true` (bundles `us-west-2-bundle.pem`, mounts
  it into api/mcp, pins `sslmode=verify-full`). Without it, verified
  connections fail (never runs with an unverified fallback).
- Secrets: signet-owned AWS Secrets Manager at `signet-<env>/runtime/*`, injected
  into the `signet` Secret by ESO. See `charts/signet/SECRETS.md`.
- Exposure: internal ALB ingress with TLS at
  `signet{,.dev,.staging}.internal.example.com` (`ingress.className: alb`,
  `alb.ingress.kubernetes.io/scheme: internal`).
- Ontology authoring (optional, off by default): set `webapp.vocbenchUiUrl` and
  `webapp.semanticTurkey.baseUrl`/`email` to enable the VocBench link and
  Semantic Turkey project list. Enabling the project list also requires
  `SEMANTIC_TURKEY_PASSWORD`, which is a secret: add it as a secret key in the
  `signet` Secret (ESO `signet-<env>/runtime/semantic-turkey-password`) and wire
  it into the webapp env. Until configured, the webapp shows ontology authoring
  as "not enabled" rather than a broken link.

## Release a new version

1. Merge to `main`; release-please opens/updates the release PR.
2. Merge the release PR — release-please creates the tag and GitHub release.
3. The `Release` workflow pushes digest-pinned images + the OCI chart to GHCR
   as `ghcr.io/<owner>/signet/{api,mcp,webapp,tessera-sidecar}` and
   `…/charts/signet`, attaches `release-manifest.json`, signs the images,
   chart, and manifest keyless (GitHub OIDC via cosign), creates GitHub
   build-provenance attestations for the images and chart, and attaches SPDX
   SBOMs (syft) to the images and to the GitHub release.
4. In the environment repo, bump the pinned chart version and apply.

Required repo variables: none for publishing (the workflow uses its
`GITHUB_TOKEN`). Optional: `SIGNET_IMAGE_NAMESPACE` / `SIGNET_CHART_REPOSITORY`
if you mirror the pipeline to a different registry layout.

## Verify release signatures before applying

Every release is signed and attested; verify a tag before pinning or applying
its digests (your environment repo's PR gate should run the same check):

```bash
scripts/verify-release-signatures.sh v0.1.53
```

(The script pulls the signed manifest from the GitHub release and verifies the
keyless signatures on it, every component image, and the chart against the
release workflow's OIDC identity. GHCR images are public for this repository;
`docker login ghcr.io` first if you mirror packages privately.) Provenance and
SBOMs are verifiable with:

```bash
gh attestation verify oci://ghcr.io/therandomsecurityguy/signet/api@sha256:...
cosign verify-attestation --type spdxjson \
  --certificate-identity-regexp '^https://github.com/therandomsecurityguy/signet/\.github/workflows/release\.yaml@' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/therandomsecurityguy/signet/api@sha256:...
```

A signature failure is a stop: do not apply the pin. Re-run the release
(`workflow_dispatch` with the tag) or investigate before proceeding.

## Pre-deploy checklist

1. The OIDC app exists in your identity provider and you have the issuer,
   client ID, and client secret.
2. Operator secrets are seeded (`charts/signet/SECRETS.md`) — especially
   `tessera-log-private-key`, which must match the signer you are migrating from.
   To enable registry-side transparency reconciliation, set
   `tesseraSidecar.logPublicKeyPem` to the matching public key PEM (public, not
   a secret; derive with `openssl pkey -pubout`) and optionally
   `tesseraSidecar.logOrigin`. Without the public key the sidecar still stages
   append intents and runs the native log, but
   `POST /v1/transparency-logs/reconcile` returns 409.
   Seed `tessera-sidecar-auth-token` (Secrets Manager); the sidecar fails
   closed without it (`/v1/*` → 401), so publishes would fail until the
   token is seeded. Local-development clusters may instead set
   `tesseraSidecar.allowUnauthenticated: true`.
3. `values-<env>.yaml` placeholders are filled.
4. The `signet-registry` and `signet-data` modules have been applied.

## Verify a deploy

```bash
kubectl -n signet get deploy,statefulset,pods
kubectl -n signet get externalsecret signet
kubectl -n signet get secretstore signet-secretsmanager
kubectl -n signet get secret signet -o jsonpath='{.data}' | jq 'keys'
curl -s https://signet.<env>.internal.example.com/healthz
```

## Verify alerting

- `docs/runbooks/alerting.md` — expected alarms, SNS subscription state, and
  the sidecar watchdog (dead-man's switch).
- After applies that change secrets or the sidecar: run the ESO force-sync +
  restart sequence from `docs/runbooks/sidecar-degraded-mode.md`.
- Rotation recipes live in `docs/runbooks/secret-rotation.md`.

- The ExternalSecret should be `Ready`; the `signet` Secret should contain the keys.
- If the ExternalSecret is not Ready, check the SecretStore exists and that the
  release ServiceAccount carries the IRSA (`eks.amazonaws.com/role-arn`) annotation.

## Rollback

Helm chart versions are immutable. Roll back by pinning the previous chart version
in the environment repo and re-applying (`helm_release` with `atomic = true` rolls back on
a failed upgrade).
