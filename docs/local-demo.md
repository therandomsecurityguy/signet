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
npm run dev -- verify publication --skill skill:tame-llama --version 1 --strict --api-token <api token>
```

The webapp's mock-Okta browser demo (optional) is printed by the seed as
`mock_okta_demo_command`.

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
