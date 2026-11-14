## `service/tessera-sidecar` - Tessera S3 Companion

This service is a narrow companion for **Signet** transparency work.

It is **not** a full Tessera deployment.

Implemented now:
- health and readiness endpoints
- config summary endpoint
- append-intent staging into an S3 prefix reserved for Tessera-related workflows
- real registry publish/certify flows can now call this sidecar when `TESSERA_SIDECAR_URL` and `TRANSPARENCY_APPEND_LOG_ID` are configured in `service/api`
- when a Tessera runtime is configured, the sidecar can submit the append-intent record and return published-checkpoint metadata when available
- native RFC 6962 companion log (activated by `TESSERA_LOG_PRIVATE_KEY`): append-intent records are appended as leaves with S3-backed tree state, signed transparency-dev checkpoints are published (`TESSERA_LOG_ORIGIN` sets the note origin), and per-entry inclusion proofs are served on `GET /v1/logs/*`
- `service/api` can reconcile recorded append intents against this log (`POST /v1/transparency-logs/reconcile`), verifying record digests, leaf hashes, inclusion proofs, and checkpoint signatures against a trusted `TESSERA_LOG_PUBLIC_KEY`

Auth is fail-closed: `healthz`, `readyz`, `/v1`, and `/v1/config` stay open
for probes/discovery; every other `/v1/*` route returns 401 unless the shared
bearer token matches. Without `TESSERA_SIDECAR_AUTH_TOKEN` the sidecar also
returns 401 (`SIDECAR_AUTH_NOT_CONFIGURED`) until
`TESSERA_SIDECAR_ALLOW_UNAUTHENTICATED=true` explicitly opts out for local
development. Within a cluster, the chart's network policy additionally limits
ingress to the api/mcp pods.

Not implemented yet:
- witness policy enforcement
- tessera binary tile-file layout compatibility (this is a native RFC 6962 log, not a tessera-format tile store)
- checkpoint gossip to external monitors

### Why it exists

Tessera is a library, not a drop-in microservice stack.

This sidecar gives the repo a practical bridge:
- the registry can move artifact storage to S3
- transparency-related append intents can be staged in the same locked-down bucket
- local/dev environments can validate bucket wiring and the future integration seam without over-claiming that Tessera itself is fully wired in-process

### Run locally

```bash
cd signet/service/tessera-sidecar
npm install
npm run dev
```

### Example env

See:
- `infra/.env.example`

Important values:
- `TESSERA_SIDECAR_BUCKET`
- `TESSERA_SIDECAR_REGION`
- `TESSERA_SIDECAR_TILES_PREFIX`
- `TESSERA_SIDECAR_REQUESTS_PREFIX`
- `TESSERA_LOG_PRIVATE_KEY` (PEM; enables the native companion log and signed checkpoints)
- `TESSERA_LOG_ORIGIN` (checkpoint note origin, default `signet-tessera.local`)
- `TESSERA_SIDECAR_AUTH_TOKEN` (shared bearer token; `/v1/*` calls must present it — the registry sends it from its own `TESSERA_SIDECAR_AUTH_TOKEN`)
- `TESSERA_SIDECAR_ALLOW_UNAUTHENTICATED=true` (explicit local-development opt-out; without it a missing token fails closed)

If you used the Terraform AWS backend example, the fastest operator path is:

```bash
cd signet/infra
make wire-tessera-aws
```

That updates the compose-backed service env files directly instead of requiring manual copy/paste from `terraform output`.

### Endpoints

- `GET /healthz`
- `GET /readyz`
- `GET /v1`
- `GET /v1/config`
- `POST /v1/append-intents`
- `GET /v1/logs` (501 unless the native log is configured)
- `GET /v1/logs/{logId}`
- `GET /v1/logs/{logId}/entries/{index}`

### First real integration path

The current intended first real flow is:
1. `service/api` publishes or certifies a governed agent/skill version
2. `service/registry` builds the publication envelope and governance artifacts
3. the registry calls `POST /v1/append-intents`
4. the sidecar stores an append-intent object in S3
5. the sidecar either submits that record to `tessera-runtime` (when `TESSERA_RUNTIME_ADD_URL` is set) or appends it to the native companion log and returns signed-checkpoint metadata
6. the returned S3 and Tessera metadata is preserved back into the registry evidence model
7. `POST /v1/transparency-logs/reconcile` re-fetches each recorded entry and re-verifies digest, inclusion, and checkpoint signature end to end

This is still a companion bridge, but it is now beyond staging-only behavior.
