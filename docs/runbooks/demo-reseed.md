# Signet — Demo data reseed

Reset the demo registry and reseed the demo pack (2 agents / 10 skills). This
clears the registry graph and re-seeds from
`client/registry-cli/examples/signet-demo/signet-demo.manifest.json`.

> Only do this on the demo environment, or when you intend to clear registry
> state. It is non-destructive to the CAS artifact bucket (orphaned objects are
> harmless) but removes all graph nodes (agents, skills, versions, provenance).

## Preconditions

- `kubectl` access to the `signet` namespace (port-forward).
- The Fuseki admin password (`signet` Secret, key `fuseki-admin-password`).
- A write/lifecycle-scoped `agk_` API key (mint one for the operator; see below).

## 1. Mint an operator key (in-cluster)

Use the API's own store so the key matches the deployed hashing. This runs a tiny
script inside the api pod:

```bash
kubectl -n signet exec deploy/signet-api -- node --input-type=module -e '
import { createDbProvider } from "/workspace/service/api/dist/service/api/src/infrastructure/persistence/db-provider.js";
import { SqliteApiKeyStore } from "/workspace/service/api/dist/service/api/src/infrastructure/auth/sqlite-api-key-store.js";
const db = createDbProvider(process.env.DATABASE_URL, { sslRootCertPath: process.env.DATABASE_SSL_ROOT_CERT }); await db.ready();
const s = new SqliteApiKeyStore(db, process.env.API_KEY_PEPPER ? { pepper: process.env.API_KEY_PEPPER } : {});
const { token } = await s.create({ owner_label: "demo-reseed", scopes: ["read","write","lifecycle"], created_by: "demo-reseed" });
process.stdout.write(token, () => process.exit(0));
'
```

`sslRootCertPath` is required wherever the database enforces TLS with the
regional RDS CA (same as the api process itself). The explicit `process.exit`
flushes the token and keeps the exec from hanging on the Postgres pool.

Store the token in your secret manager; revoke it when done (step 4).

## 2. Clear the registry graph

```bash
PW="$(kubectl -n signet get secret signet -o jsonpath='{.data.fuseki-admin-password}' | base64 -d)"
kubectl -n signet port-forward svc/signet-fuseki 3030:3030 & sleep 5
curl -s -o /dev/null -u "admin:$PW" -X POST \
  -H 'content-type: application/sparql-update' --data 'CLEAR ALL' \
  http://127.0.0.1:3030/registry/update    # -> 204
kill %1
```

## 3. Reseed the pack

```bash
kubectl -n signet port-forward svc/signet-api 3100:3100 & sleep 5
API_ORIGIN=http://127.0.0.1:3100 \
node client/registry-cli/dist/main.js seed bootstrap \
  --manifest client/registry-cli/examples/signet-demo/signet-demo.manifest.json \
  --profile default --api-token "<agk_…>"
kill %1
```

Profiles: `default` (all), `registry`, `security`, `platform`. Or seed specific
items with `--skill-item-id <id> --agent-item-id <id>`.

The demo manifest enables **signing**: the seed generates (once, under
`data/registry-operator/demo-signing-key.pem`, gitignored) an ephemeral
ed25519 demo key, registers it as a trusted key owned by `registry-operator`,
and attaches a real detached signature to each published skill's frozen
envelope after publish. Re-seeding is idempotent: the same key does not sign
twice.

## 4. Verify and clean up

```bash
kubectl -n signet port-forward svc/signet-api 3100:3100 & sleep 5
curl -s http://127.0.0.1:3100/v1/skills | jq '.skills | length'   # -> 10
curl -s http://127.0.0.1:3100/v1/agents | jq '.agents | length'   # -> 2
API_ORIGIN=http://127.0.0.1:3100 \
  node client/registry-cli/dist/main.js verify publication \
    --skill skill:registry-search --version 1 --strict             # -> verdict: verified
API_ORIGIN=http://127.0.0.1:3100 \
  node client/registry-cli/dist/main.js verify artifact \
    --sha256 "$(curl -s http://127.0.0.1:3100/v1/skills/skill%3Aregistry-search/versions/1 | jq -r '.artifacts[0].sha256')"
kill %1
```

The reseed's validations ran through the W3C SHACL engine; inspect a
machine-readable report (the graph-shape layer records
`shapes_format: "shacl-turtle"`):

```bash
kubectl -n signet port-forward svc/signet-api 3100:3100 & sleep 5
V=$(curl -s http://127.0.0.1:3100/v1/skills/skill%3Aregistry-search/versions/1)
for SHA in $(echo "$V" | jq -r '.governance_artifacts[] | select(.role=="validation_report") | .sha256'); do
  curl -s "http://127.0.0.1:3100/v1/artifacts/$SHA" \
    | jq 'select(.payload.validator == "shacl-v1") | { validator: .payload.validator,
        engine: .payload.engine, conforms: .payload.conforms,
        shapes: .payload.layers[0].shapes_format }'
done
kill %1
```

Then revoke the operator key:

```bash
kubectl -n signet exec deploy/signet-api -- node --input-type=module -e '
import { createDbProvider } from "/workspace/service/api/dist/service/api/src/infrastructure/persistence/db-provider.js";
import { SqliteApiKeyStore } from "/workspace/service/api/dist/service/api/src/infrastructure/auth/sqlite-api-key-store.js";
const db = createDbProvider(process.env.DATABASE_URL, { sslRootCertPath: process.env.DATABASE_SSL_ROOT_CERT }); await db.ready();
const s = new SqliteApiKeyStore(db, process.env.API_KEY_PEPPER ? { pepper: process.env.API_KEY_PEPPER } : {});
await s.revoke({ key_id: process.argv[2] });
process.stdout.write("revoked\n", () => process.exit(0));
' -- "<key_id>"
```

## Notes

- The webapp home dashboard shows the agent/skill counts (currently 2 / 10).
- `POST /v1/compile/skill` on the demo markdown returns the frontmatter-derived
  capability claims and constraints (useful for the compiler walkthrough).
