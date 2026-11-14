# Secret rotation

Rotation recipes for the operator-seeded secrets (see
`charts/cachet/SECRETS.md` for seeding). All values live in AWS Secrets
Manager under `<prefix>/` and reach pods via External Secrets; pods only read
env at start, so **rotations need an ESO force-sync + rollout restart** of the
affected workloads.

## General sequence

```bash
# 1. rotate in Secrets Manager
aws secretsmanager put-secret-value --secret-id <prefix>/<key> --secret-string <value>
# 2. force ESO to re-read now (default refresh is 1h)
kubectl -n cachet annotate externalsecret cachet force-sync=$(date +%s) --overwrite
# 3. confirm the k8s secret has the new value, then restart readers
kubectl -n cachet rollout restart deploy/<affected>
```

## Tessera checkpoint key (`tessera-log-private-key`)

Signs the native transparency log's checkpoints. The registry verifies them
against `tesseraSidecar.logPublicKeyPem`.

**Rotation is breaking unless the registry trust is updated in the same
change** — there is no key-overlap today (one trusted key, note key-hint =
sha256(SPKI DER)[0:4]).

1. Generate: `openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out log-key.pem`
   (EC P-256; the signer uses `sha256` digests, so do not use Ed25519).
2. `aws secretsmanager put-secret-value --secret-id <prefix>/tessera-log-private-key --secret-string file://log-key.pem`
3. Derive the public key: `openssl pkey -in log-key.pem -pubout` and update
   `tesseraSidecar.logPublicKeyPem` in the environment values, then apply.
4. ESO force-sync + restart the sidecar.
5. Historical checkpoints signed with the old key will no longer verify until
   a dual-key overlap is implemented — treat pre-rotation reconcile runs as
   expected-to-fail and keep the old PEM recorded if you need to audit them.

## Sidecar shared token (`tessera-sidecar-auth-token`)

Bearer auth between the registry and the sidecar. Both reader pods must move
together; during the window between secret sync and the second restart,
appends fail loudly (401).

1. `aws secretsmanager put-secret-value --secret-id <prefix>/tessera-sidecar-auth-token --secret-string "$(openssl rand -hex 32)"`
2. ESO force-sync, confirm the key, then restart **both**
   `deploy/cachet-tessera-sidecar` and `deploy/cachet-api` in the same
   rollout (they read the same release secret).
3. Verify: watchdog job logs `{"healthy":true}`; a test publish reconciles
   `verified`.

## Okta client secret

Rotate in the Okta app first, then update `<prefix>/okta-client-secret`,
force-sync, and restart `deploy/cachet-webapp` (and `deploy/cachet-api` if it
holds a copy). Old credentials keep working until the okta app's rotation
window closes only if Okta issued a grace period — otherwise webapp logins
fail until the new value lands.

## API key pepper (`api-key-pepper`)

**Do not rotate today.** The hash verification accepts a single pepper, so
rotation invalidates every existing API key. Rotating requires first shipping
dual-pepper verification (accept old + new during a migration window) plus a
rehash path — tracked as future work in the ecosystem review.

## RDS / Redis / Fuseki credentials

- `database-url` / `redis-url` are Terraform-generated (`cachet-data`
  module). Rotating them means changing the generated password and the
  consumers in the same apply; the module currently regenerates only when
  replaced (`-replace`) — coordinate with a maintenance window.
- `fuseki-admin-password` is similarly Terraform-owned; webapp/api/mcp read
  it from the release secret.
