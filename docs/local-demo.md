# Local demo (no Docker, no AWS, no Kubernetes)

Signet runs fully self-contained: no AWS account, no ECR, no External Secrets,
no S3. Three ways to run it locally, in increasing fidelity to a real
deployment:

| Option | Needs | Fidelity |
|---|---|---|
| 1. `scripts/demo-local.sh` (recommended) | Node >= 20 | Services on the host: SQLite, JSON-file graph, filesystem CAS |
| 2. Docker Compose | a container runtime | Adds Fuseki (SPARQL), Tessera sidecar/runtime, MySQL, VocBench |
| 3. Local Kubernetes (kind or OrbStack) | Docker + helm (+ kind, or OrbStack on macOS) | The real Helm chart via `charts/signet/values-local.yaml` |

## Option 1 — host processes (`scripts/demo-local.sh`)

```bash
# once: install dependencies
for d in service/api service/mcp service/webapp/knowledge-manager client/registry-cli; do
  (cd "$d" && npm ci)
done

scripts/demo-local.sh demo
```

`demo` resets local state, starts api (:3100), mcp (:3000), and the webapp
(:3200), then seeds the blessed demo pack with `registry-operator`:

- 1 agent: `cursor:registry-agent`
- 2 skills: `skill:registry-mcp`, `skill:tame-llama` (published, with
  digest-verified artifacts)
- a Cursor MCP config block and scripted prompts for a first agent session
  (printed at the end of the run)

Other subcommands: `up`, `seed`, `status`, `down`, `reset` (reset refuses
while services are running — always `down` before `reset`; state lives in
`./data/`).

Sanity checks:

```bash
curl -s localhost:3100/v1/skills          # seeded skills
curl -s localhost:3200/                   # webapp UI

# Agent-side walkthrough with the MCP token printed by the seed:
#   registry.list_agents → registry.get_agent cursor:registry-agent
#   registry.list_skills → registry.get_skill skill:tame-llama
#   registry.get_artifact <sha256>        # digest_verified: true
```

Verify-before-load, offline repeat of the seed checks:

```bash
cd client/registry-cli
npm run dev -- verify mcp --mcp-token <mcp token from the seed output>
npm run dev -- verify publication --skill skill:tame-llama --version 1 --api-token <api token>
```

The host demo pack is not signed, so `verify publication` reports
`verdict: verified` without signatures; `--strict` additionally requires a
valid detached signature and only passes for signed packs (the Kubernetes
`signet-demo` manifest signs — see `docs/runbooks/demo-reseed.md`).

Every seeded validation already runs through the W3C SHACL engine: the
graph-shape layer's report entry records `validator: shacl-v1`, the engine
version, and `shapes_format: "shacl-turtle"` with the built-in shapes
digest. To see it for a seeded skill:

```bash
API=http://localhost:3100
TOK=<api token from the seed output>
V=$(curl -s -H "authorization: Bearer $TOK" "$API/v1/skills/skill%3Aregistry-mcp/versions/1")
SHA=$(echo "$V" | jq -r '.governance_artifacts[] | select(.role=="validation_report") | .sha256' | head -1)
curl -s -H "authorization: Bearer $TOK" "$API/v1/artifacts/$SHA" | jq .payload.validator   # -> "shacl-v1"
```

The webapp's mock-Okta browser demo (optional) is printed by the seed as
`mock_okta_demo_command`.

## SHACL policy walkthrough (verified)

Registers an authored W3C SHACL Turtle policy against the running host
demo, drives a draft through rejection and certification, and inspects the
machine-readable validation reports. Every step below is copy-paste
runnable against `scripts/demo-local.sh demo` state.

A recorded run of this walkthrough — combined with the browser console —
is committed at [`demo/signet-demo.mp4`](demo/signet-demo.mp4) (preview
GIF inlined in the root README); regenerate it with
`service/webapp/knowledge-manager/scripts/demo-video.ts`.

```bash
API=http://localhost:3100
TOK=<api token from the seed output>   # or mint one:
# (cd service/api && DATABASE_URL="file:$PWD/../../data/api/signet-api.db" \
#   NODE_ENV=development node --import tsx scripts/create-api-key.ts \
#   --owner-label demo --scopes read,write,lifecycle)

# 1. Register the policy (gates are top-level fields for Turtle policies).
curl -s -H "authorization: Bearer $TOK" -H 'content-type: application/json' \
  -X POST "$API/v1/policy-packages" -d '{
    "policy_version": "demo-shacl/v1",
    "author": "demo",
    "shapes_format": "shacl-turtle",
    "require_validation": true,
    "shapes": "@prefix sh: <http://www.w3.org/ns/shacl#> .\n<urn:policy:description> a sh:NodeShape ;\n    sh:targetClass <urn:sg:entity-type:SKILL_VERSION> ;\n    sh:property [ sh:path <urn:sg:property:description> ; sh:minCount 1 ; sh:message \"description_required_by_demo_shacl_policy\" ] ."
  }' | jq '{created, format: .policy_package.shapes_format, sha: .policy_package.sha256[0:12]}'
# -> created: true, format: "shacl-turtle"

# 2. A draft without a description is rejected by the turtle policy.
curl -s -H "authorization: Bearer $TOK" -H 'content-type: application/json' \
  -X POST "$API/v1/skills/skill%3Ashacl-demo/drafts" -d '{
    "author": "demo",
    "artifact": { "content": "# shacl demo", "original_path": "skills/shacl-demo.md" },
    "governance": { "policy_version": "demo-shacl/v1" }
  }' >/dev/null
curl -s -H "authorization: Bearer $TOK" -H 'content-type: application/json' \
  -X POST "$API/v1/skills/skill%3Ashacl-demo/versions/1/validate" -d '{"author":"demo"}' \
  | jq '{lifecycle: .result.skill_version.properties.lifecycle_status,
         failures: .result.skill_version.properties.validation_failures}'
# -> lifecycle: "rejected", failures: ["description_required_by_demo_shacl_policy"]

# 3. The report shows the W3C engine, the Turtle policy layer, and the
#    policy package digest it executed.
V=$(curl -s -H "authorization: Bearer $TOK" "$API/v1/skills/skill%3Ashacl-demo/versions/1")
for SHA in $(echo "$V" | jq -r '.governance_artifacts[] | select(.role=="validation_report") | .sha256'); do
  curl -s -H "authorization: Bearer $TOK" "$API/v1/artifacts/$SHA" \
    | jq 'select(.payload.validator == "shacl-v1") | { validator: .payload.validator,
        engine: .payload.engine, conforms: .payload.conforms,
        policy_format: .payload.layers[1].shapes_format,
        policy_sha: .payload.layers[1].shapes_sha256[0:12],
        violation: .payload.layers[1].violations[0].message }'
done
# -> validator: "shacl-v1", engine: "rdf-validate-shacl@0.7.0",
#    policy_format: "shacl-turtle", violation: "description_required_by_demo_shacl_policy"

# 4. A conforming draft passes validation, publish is gated on it, and
#    certify completes the lifecycle.
curl -s -H "authorization: Bearer $TOK" -H 'content-type: application/json' \
  -X POST "$API/v1/skills/skill%3Ashacl-demo-ok/drafts" -d '{
    "author": "demo",
    "description": "SHACL demo skill with a description",
    "artifact": { "content": "# shacl demo ok", "original_path": "skills/shacl-demo-ok.md" },
    "governance": { "policy_version": "demo-shacl/v1" }
  }' >/dev/null
for STEP in validate publish certify; do
  curl -s -H "authorization: Bearer $TOK" -H 'content-type: application/json' \
    -X POST "$API/v1/skills/skill%3Ashacl-demo-ok/versions/1/$STEP" -d '{"author":"demo"}' \
    | jq -r --arg step "$STEP" '"\($step): \(.result.skill_version.properties.lifecycle_status)"'
done
# -> validate: validated, publish: published, certify: certified
```

Authoring conventions (enforced at registration): `sh:targetClass` over
`urn:sg:entity-type:` IRIs, simple `urn:sg:property:`/`urn:sg:predicate:`
paths, and `sh:pattern` that compiles under RE2 (linear-time execution,
no backreferences/lookarounds); explicit node targeting is rejected. See
`docs/api-reference.md` for both policy formats.

### Try before you bind (verified)

Dry-run a registered policy against existing versions — the verdicts match
what `validate` would decide, with zero lifecycle side effects (no reports,
artifacts, tasks, events, or writes) — and ask which gate would reject a
publish/certify and why, before attempting:

```bash
# 5. Simulate the policy from step 1 against the rejected draft and the
#    conforming version: standard per-target verdicts, nothing recorded.
curl -s -H "authorization: Bearer $TOK" -H 'content-type: application/json' \
  -X POST "$API/v1/policy-packages/demo-shacl%2Fv1/simulate" \
  -d '{"publication_urns":["urn:sg:skill-version:skill:shacl-demo@v1",
                           "urn:sg:skill-version:skill:shacl-demo-ok@v1"]}' \
  | jq '{conforms, targets: [.targets[] | {urn: .publication_urn, conforms, failures}]}'
# -> shacl-demo@v1 conforms: false, failures: ["description_required_by_demo_shacl_policy"]

# 6. Gate hints on a fresh draft: publish is blocked because the policy
#    requires validation (the hint mirrors enforcement exactly; read-only).
curl -s -H "authorization: Bearer $TOK" -H 'content-type: application/json' \
  -X POST "$API/v1/skills/skill%3Agate-hints-demo/drafts" -d '{
    "author": "demo",
    "description": "gate hints demo",
    "artifact": { "content": "# gate hints demo", "original_path": "skills/gate-hints-demo.md" },
    "governance": { "policy_version": "demo-shacl/v1" }
  }' >/dev/null
curl -s -H "authorization: Bearer $TOK" \
  "$API/v1/skills/skill%3Agate-hints-demo/versions/1/gate-hints" \
  | jq '{policy_version, would_publish, would_certify,
         gates: [.gates[] | select(.applicable) | {gate, operation, satisfied, reason}]}'
# -> would_publish: false; require_validation (publish) satisfied: false,
#    reason: "lifecycle is draft; policy demo-shacl/v1 requires validation before publish"
```

In the browser (webapp, `kubectl -n signet port-forward svc/signet-webapp 3200:3200`
for the k8s demo): the **Playground** page (`/policy-playground`) runs the
simulate call from a form (sign in with the mock Okta button first), and
skill/agent detail pages render the per-version gate hints next to the
lifecycle actions.

## Witness network walkthrough (verified)

Reads the transparency sample graph seeded by `scripts/demo-local.sh seed`
(which seeds it alongside the demo catalog) — two witnesses, checkpoint
attestations and a cosignature, observations, and a gossip event — and
shows the read-only witness views. Every step below is copy-paste runnable
against `scripts/demo-local.sh demo` state.

```bash
API=http://localhost:3100
TOK=<api token from the seed output>   # or mint one:
# (cd service/api && DATABASE_URL="file:$PWD/../../data/api/signet-api.db" \
#   NODE_ENV=development node --import tsx scripts/create-api-key.ts \
#   --owner-label demo --scopes read,write,lifecycle)

# 1. The seeded log ships with two witnesses, two checkpoints, and a
#    verified witness-alpha -> witness-beta gossip event (depth 1).
curl -s -H "authorization: Bearer $TOK" \
  "$API/v1/transparency-logs/sg-transparency-sample-log" \
  | jq '{witnesses: [.witnesses[].witness_id], checkpoints: (.checkpoints | length),
         gossip: [.gossip_events[] | {from_witness_id, to_witness_id, relay_hop_count}]}'
# -> witnesses: ["witness-alpha", "witness-beta"], checkpoints: 2,
#    gossip: [{from_witness_id: "witness-alpha", to_witness_id: "witness-beta", relay_hop_count: 1}]

# 2. Quorum verification reads attestations AND note cosignatures
#    (fail-closed: a witness can only gossip what it has endorsed).
curl -s -H "authorization: Bearer $TOK" \
  "$API/v1/transparency-logs/sg-transparency-sample-log/verification" \
  | jq '{checkpoint_signature_valid, witness_quorum_required, witness_quorum_met,
         checks: [.witness_checks[] | {witness_id, verification_status}]}'
# -> checkpoint_signature_valid: true, witness_quorum_required: 2,
#    witness_quorum_met: true, checks: witness-alpha/witness-beta "verified"

# 3. Cross-log coverage comes from cryptographic evidence only.
curl -s -H "authorization: Bearer $TOK" \
  "$API/v1/transparency-logs/witness/coverage" \
  | jq '{totals, witnesses: [.witnesses[] | {witness_id, logs_witnessed, checkpoints_witnessed}]}'
# -> totals: {logs: 1, witnesses: 2, cross_log_witnesses: 0},
#    witness-alpha: 1 log / 2 checkpoints, witness-beta: 1 log / 1 checkpoint

# 4. Advisory, deterministic scoring is opt-in — components, weights, and
#    evidence ship with the score; nothing in validation, quorum, or
#    gating reads it, and recency is data-relative (never wall clock).
curl -s -H "authorization: Bearer $TOK" \
  "$API/v1/transparency-logs/witness/coverage?include_scoring=true" \
  | jq '[.witnesses[] | {witness_id, score: .scoring.score, components: .scoring.components}]'
# -> witness-alpha: score 100 {breadth: 1, participation: 1, recency: 1},
#    witness-beta:  score 80  {breadth: 1, participation: 0.5, recency: 1}

# 5. The timeline projects the same evidence as events.
curl -s -H "authorization: Bearer $TOK" \
  "$API/v1/transparency-logs/sg-transparency-sample-log/timeline" \
  | jq '[.events[] | select(.kind == "gossip") | {occurred_at, summary}]'
# -> occurred_at: "2026-01-03T00:13:00.000Z",
#    summary: "Witness witness-alpha gossiped checkpoint to witness-beta."
```

Governance notes: gossip provenance is fail-closed (only witnesses
attached to the log may gossip, the source must hold a valid attestation
or verified cosignature for the checkpoint, and relay claims must resolve
to a verified prior event with a consistent chain depth); witness
independence is enforced per log — one key material per party
(`TRANSPARENCY_WITNESS_DUPLICATE_KEY` on duplicate attachment), with the
same key allowed across different logs.

## Option 2 — Docker Compose

```bash
cd client/registry-cli
npm run dev -- bootstrap test --reset --force --up     # resets, runs `make up`, seeds, verifies
```

or split it: `cd infra && make up`, then `npm run dev -- bootstrap test
--force` from `client/registry-cli`. Note `--reset` deletes the SQLite
databases, so only ever use it while the stack is down (`--up` orders
reset-before-start for you).

## Option 3 — local Kubernetes (kind or OrbStack)

Uses the real chart with `charts/signet/values-local.yaml`: SQLite, filesystem
CAS, chart-managed dev Secret, no ingress/ESO/IRSA/sidecar, and a shared PVC
mounted at `/workspace/data` in api + mcp so the CAS written by the
management plane is readable by the MCP plane.

### Recommended: the update script

`scripts/demo-k8s-update.sh` builds the images, loads them into kind when
needed (OrbStack shares its image store), upgrades the Helm release, waits
for the api/mcp/webapp rollouts, and runs in-cluster `/healthz` checks. Demo
state on the chart PVC survives updates.

```bash
scripts/demo-k8s-update.sh                     # build from the working tree
scripts/demo-k8s-update.sh --no-build          # reuse existing :dev images
scripts/demo-k8s-update.sh --release v0.1.85   # verify + deploy released images
```

`--release` runs `scripts/verify-release-signatures.sh` first (fail-closed)
and pins the verified digests from the release manifest; released images are
linux/amd64 (emulated on Apple Silicon — local builds are native). Run
`git pull` — or check out the release tag — first: chart and values come from
the working tree.

### Manual path

Build the images first (both paths):

```bash
docker build -f service/api/Dockerfile -t signet/api:dev .
docker build -f service/mcp/Dockerfile -t signet/mcp:dev .
docker build -f service/webapp/knowledge-manager/Dockerfile -t signet/webapp-knowledge-manager:dev .
```

### OrbStack (macOS, shortest path)

OrbStack shares its Docker image store with its built-in Kubernetes, so there
is no cluster-create or image-load step:

```bash
orb start k8s
helm upgrade --install signet charts/signet -f charts/signet/values-local.yaml -n signet --create-namespace
kubectl -n signet port-forward svc/signet-api 3100:3100 &
kubectl -n signet port-forward svc/signet-mcp 3000:3000 &
kubectl -n signet port-forward svc/signet-webapp 3200:3200 &
```

### kind

```bash
kind create cluster --name signet
kind load docker-image --name signet signet/api:dev signet/mcp:dev signet/webapp-knowledge-manager:dev
helm install signet charts/signet -f charts/signet/values-local.yaml -n signet --create-namespace
kubectl -n signet port-forward svc/signet-api 3100:3100 &
kubectl -n signet port-forward svc/signet-mcp 3000:3000 &
kubectl -n signet port-forward svc/signet-webapp 3200:3200 &
```

### Seed

The overlay runs the `dual` auth mode with mock Okta, so any bearer token
acts as an admin (mock principal):

```bash
cd client/registry-cli
npm run dev -- bootstrap test --force --api-token demo-admin --mcp-token demo-admin
```

Then browse `localhost:3200` (webapp), `localhost:3100/v1/docs` (API), and
point an MCP client at `http://localhost:3000/mcp` with
`Authorization: Bearer demo-admin`.

### Reset

The registry graph (Fuseki PVC) and the shared CAS PVC persist across
restarts. To rebuild the demo state from scratch:

```bash
helm uninstall signet -n signet
kubectl -n signet delete pvc --all
helm install signet charts/signet -f charts/signet/values-local.yaml -n signet --create-namespace
# re-run the port-forwards and the seed
```

## What a real deployment adds

The AWS/EKS path keeps the same architecture but swaps the local backends for
managed ones: Postgres instead of SQLite, S3/KMS instead of the filesystem
CAS, Secrets Manager + External Secrets instead of the chart Secret, an
ingress with real OIDC instead of port-forwards, and the Tessera sidecar with
an S3-backed transparency log. See `docs/runbooks/deploy.md` and
`charts/signet/SECRETS.md`.
