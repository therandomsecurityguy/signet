# Tessera sidecar degraded mode

Publishing **hard-depends on the tessera-sidecar**: validate/publish/create
record append intents, and governance-artifact intent failures are not
swallowed (by design — a half-configured pair must fail loudly rather than
publish without transparency intent). The reconciliation endpoint is also
backed by it. Know the failure modes before responding.

## Symptoms

- `cachet-<env>-sidecar-unhealthy` alarm (watchdog metric missing or 0).
- `validate` / `publish` returning 500 with
  `Transparency append sidecar request failed (...)`.
- `POST /v1/transparency-logs/reconcile` failures or `fetch_failed` outcomes.
- Sidecar pod not Ready / crash-looping.

## Triage

```bash
kubectl -n cachet get pods | grep tessera-sidecar
kubectl -n cachet logs deploy/cachet-tessera-sidecar --tail=100
kubectl -n cachet exec deploy/cachet-api -- \
  node -e "fetch('http://cachet-tessera-sidecar:3400/healthz').then(r=>console.log(r.status))"
```

- `/healthz` failing: inspect pod events, S3 access (IRSA), and the log key
  env. A **missing/invalid `TESSERA_LOG_PRIVATE_KEY`** makes append fail at
  checkpoint signing — confirm the secret is a real PEM
  (`kubectl -n cachet get secret cachet -o jsonpath='{.data.tessera-log-private-key}' | base64 -d | head -1`
  should print `-----BEGIN PRIVATE KEY-----`).
- `401 SIDECAR_AUTH_NOT_CONFIGURED` / `401 UNAUTHORIZED`: the shared token is
  missing or mismatched. Both sides read
  `tessera-sidecar-auth-token` from the release secret — see the force-sync
  sequence below.
- Sidecar up but probe unhealthy on auth: `auth_enabled` false while a token
  is configured (secret arrived after the pod started).

## The ESO sync + restart sequence

The release secret is synced by External Secrets (default refresh 1h), and
pods only read env at start. After seeding/rotating the token or the log key:

```bash
kubectl -n cachet annotate externalsecret cachet force-sync=$(date +%s) --overwrite
# wait until the key is present
kubectl -n cachet get secret cachet -o jsonpath='{.data.tessera-sidecar-auth-token}' | base64 -d | wc -c
# restart both readers so their env snapshots pick it up
kubectl -n cachet rollout restart deploy/cachet-tessera-sidecar deploy/cachet-api
```

Data plane and sidecar roll together; appends during the restart window fail
loudly (retryable by the caller: the append fetch retries transient failures
once, but sustained downtime surfaces).

## What is safe / not safe

- **Do not scale the sidecar replicas.** The native log is single-writer
  (leaf list → state write); two replicas race the tree without an S3 lock.
  Recovery is fast rescheduling, not horizontal scaling.
- The watchdog CronJob covers availability; if it is firing for a **stopped**
  CronJob (no metric), check the CronJob/schedule/RBAC before blaming the
  sidecar.
- NetworkPolicy: only api/mcp pods and the watchdog may reach the sidecar —
  a new prober must be added to the sidecar ingress policy.

## Publishes while the sidecar is down

There is no degraded publish path today: lifecycle operations fail. If the
sidecar outage is expected to be prolonged, the deliberate options are
(a) fix the sidecar, or (b) a code change moving artifact intents to an
outbox/retry — do not silence the failure.
