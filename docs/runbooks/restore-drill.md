# Cachet — data restore drills (RPO/RTO)

How to prove, on a schedule, that Cachet's data can actually be restored:
transactional state (RDS Postgres), registry metadata (Fuseki), artifact
bytes (S3 CAS), and transparency-log state (S3). Non-destructive drills are
the default; the last section is the real restore procedure.

Cross-references: `alerting.md` (what fires when backups stop),
`secret-rotation.md` (credentials used below), `deploy.md` (release/Argo
mechanics).

## What holds what

| Data | Store | Backup mechanism | Restore source |
|---|---|---|---|
| API keys, audit events, sessions | RDS Postgres | Automated backups, **35-day retention**, point-in-time recovery (PITR) | Snapshot / PITR → new instance |
| Registry graph metadata (nodes, edges, evidence links) | Fuseki StatefulSet + PVC | **Daily dump** CronJob → S3 bucket `security-prod-cachet-artifacts`, prefix `cachet/prod/backups/fuseki/<date>.nq.gz` (90-day lifecycle) | Dump file → import |
| Artifact/envelope bytes (CAS) | S3 `security-prod-cachet-artifacts` | S3 durability; versioning per bucket setting | In-place (no restore expected) |
| Transparency log (Tessera tree state, leaves, staged requests) | S3 under `cachet/prod/tessera/**` | S3 durability | In-place |
| Redis | ElastiCache | Node replacement | **Treated as cache**: rebuilt empty; never a source of truth |

Proposed targets (revisit if the product bar changes):

- **RPO**: RDS ≤ 5 min (PITR); Fuseki ≤ 24 h (daily dump); CAS/Tessera ~0.
- **RTO**: RDS restore + repoint ≈ 30–60 min; Fuseki import ≈ 30–60 min;
  read-only registry downtime equals the metadata restore window.

## Pre-flight (any drill)

```bash
# Contexts and names (discover, don't guess):
BUCKET=security-prod-cachet-artifacts
AWS_PROFILE=cachet-admin kubectl --context cachet-prod -n cachet get cronjob   # cachet-fuseki-backup schedule
AWS_PROFILE=cachet-admin kubectl --context cachet-prod -n cachet get sts cachet-fuseki
aws rds describe-db-instances --region us-west-2 \
  --query 'DBInstances[].{id:DBInstanceIdentifier,class:DBInstanceClass,az:MultiAZ,retention:BackupRetentionPeriod}'
aws s3 ls "s3://$BUCKET/cachet/prod/backups/fuseki/" | tail -3
aws s3api get-bucket-versioning --bucket "$BUCKET"
```

Record the output in the drill log (bottom of this page).

## Drill 1 — RDS point-in-time restore (non-destructive)

Restore to a **scratch instance**, never in place:

```bash
SOURCE_ID=<from describe-db-instances above>
RESTORE_TIME=$(date -u -v-30M +"%Y-%m-%dT%H:%M:%SZ")   # 30 minutes ago

aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier "$SOURCE_ID" \
  --target-db-instance-identifier "cachet-drill-$(date -u +%m%d%H%M)" \
  --restore-time "$RESTORE_TIME" \
  --db-instance-class db.t4g.medium \        # cheapest class that can mount the data
  --no-publicly-accessible --region us-west-2
```

Wait for `available`, then validate **from inside the cluster** (RDS is
VPC-private):

```bash
AWS_PROFILE=cachet-admin kubectl --context cachet-prod -n cachet run drill-pg --rm -it \
  --image=postgres:16-alpine --restart=Never -- \
  psql "<scratch-endpoint-conn-string>" -c "\dt" \
  -c "select count(*) from api_keys;" -c "select count(*) from audit_events;"
```

Expect the migration tables and plausible counts (compare with live via the
same queries against the prod secret's `database-url`). Then delete the
scratch instance (no final snapshot — it is a drill):

```bash
aws rds delete-db-instance --db-instance-identifier <cachet-drill-…> \
  --skip-final-snapshot --region us-west-2
```

## Drill 2 — Fuseki dump restore (non-destructive)

Import the newest dump into a **scratch Fuseki** (docker locally or a throwaway
namespace), not prod:

```bash
DUMP=$(aws s3 ls "s3://$BUCKET/cachet/prod/backups/fuseki/" | tail -1 | awk '{print $4}')
aws s3 cp "s3://$BUCKET/cachet/prod/backups/fuseki/$DUMP" /tmp/fuseki-dump.nq.gz
gunzip -k /tmp/fuseki-dump.nq.gz

docker run -d --name drill-fuseki -p 3031:3030 stain/jena-fuseki   # or a scratch pod
sleep 5
curl -u admin:admin -X POST "http://127.0.0.1:3031/$/datasets?dbName=registry&dbType=tdb2"

# Graph Store upload (RDF/ N-Quads is the document format of the dump):
curl -u admin:admin -X POST -H "Content-Type: application/n-quads" \
  --data-binary @/tmp/fuseki-dump.nq \
  "http://127.0.0.1:3031/registry/data?default"

curl -u admin:admin "http://127.0.0.1:3031/registry/sparql" \
  --data-urlencode 'query=SELECT (COUNT(*) AS ?n) WHERE { ?s ?p ?o }' \
  -H "Accept: application/sparql-results+json"
```

Cross-check the triple count against the live graph
(`kubectl … port-forward svc/cachet-fuseki 3030:3030` + the same query).
Also verify the dump contains the latest known nodes (e.g. the newest
`deploy:security-prod/*` agent URN from the registry API).

Cleanup: `docker rm -f drill-fuseki` (or delete the scratch namespace).

## Drill 3 — CAS and transparency-log spot checks (read-only)

```bash
# Artifact bytes are verified on read: a 200 here proves digest integrity.
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "CF-Access-Client-Id: $CACHET_CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CACHET_CF_ACCESS_CLIENT_SECRET" \
  https://cachet-api.tunnel.together.ai/v1/artifacts/<known-sha256>

# Transparency state present:
aws s3 ls "s3://$BUCKET/cachet/prod/tessera/tiles/prod/" | head -3
aws s3 ls "s3://$BUCKET/cachet/prod/tessera/requests/prod/" | tail -3

# The registry can reconcile its staged intents against the live log:
curl -s -X POST ... /v1/transparency-logs/reconcile   # see docs/runbooks/alerting.md for auth details
```

## Real restore procedure (incident, in order)

1. **Freeze writers** — scale `cachet-api` and `cachet-mcp` to 0
   (`kubectl -n cachet scale deploy/cachet-api --replicas=0`). Registry goes
   read-only-offline; that is intentional.
2. **RDS**: restore via PITR to the *target* time into a **new** instance
   (same drill commands, without `--skip-final-snapshot` thinking — for the
   real restore you may want a final snapshot of the broken instance first).
   Update the `database-url` secret in ASM (`cachet-prod/runtime`) to the new
   endpoint; ESO refresh interval is 1h — force it (`kubectl -n cachet
   annotate externalsecret cachet force-sync=$(date +%s) --overwrite`) or
   restart the deployments.
3. **Fuseki**: scale the StatefulSet to 0, mount a fresh PVC (or clear the
   dataset), start Fuseki, then import the chosen dump exactly as in Drill 2
   (use the prod dataset name `registry`). Choose the dump **at or before**
   the RDS restore time to keep the two stores consistent (dumps are daily;
   graph mutations since the dump will be absent — re-derive where possible
   from CAS evidence, otherwise accept the documented gap in the incident
   record).
4. **Scale up** api/mcp; verify `GET /readyz` and verify a known publication:
   `registry-operator verify publication --skill skill:argocd-break-glass --version 1 --strict`.
5. **Transparency**: run `POST /v1/transparency-logs/reconcile` and confirm
   checkpoint history still verifies; the Tessera sidecar state is S3-resident
   and should have survived untouched.
6. **Redis**: let it come up empty; sessions re-establish on next login.
7. Record: incident timeline, chosen restore points, observed RPO/RTO.

## Drill cadence and log

- **Quarterly** (or after any backup-path change): Drill 1 + Drill 2, one
  operator, ~1 hour. Drill 3 rides along with any registry release check.
- Fail the drill if: scratch restore cannot reach expected counts, the newest
  dump is older than 26 h, or bucket versioning/lifecycle drifted from this
  document.

| Date | Drill | Operator | Result | RPO observed | RTO observed | Notes |
|------|-------|----------|--------|--------------|--------------|-------|
| 2026-11-11 | Fuseki backup creation (first manual) | dac | pass | n/a (creation) | n/a | 49 KB gz, 1602 lines, `FusekiBackupSuccess=1`, completeness cross-checked |
|  |  |  |  |  |  |  |

*If a drill changes this document (new command, new failure mode), land the
edit in the same PR as the fix.*
