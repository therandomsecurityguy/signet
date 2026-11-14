## `client/registry-cli` — Registry Operator CLI

This package is the operator/assistant CLI for **Signet**.

Its first job is local-first bootstrap:
- bring the stack up or down
- clean local state safely
- create write credentials
- seed lifecycle-aware skills
- seed agents that reference those skills
- verify API and MCP discovery/load

### Current direction
- target `service/api` for all management-plane writes
- target `service/mcp` for discovery/load verification
- keep bootstrap local-first
- keep real live-Okta proof as a second lane after the basic bootstrap path is green

### Command shape
- `registry-operator local up`
- `registry-operator local down`
- `registry-operator local reset --force`
- `registry-operator auth create-api-key`
- `registry-operator seed skill`
- `registry-operator seed agent`
- `registry-operator seed bootstrap`
- `registry-operator seed transparency-sample`
- `registry-operator verify api`
- `registry-operator verify mcp` — re-hashes every fetched artifact locally
  (`digest_verified` plus a content hash when not truncated)
- `registry-operator verify publication (--skill <key> | --agent <key>) --version <n> [--strict]`
  — server verdicts plus client-side checks (canonical digest recomputation,
  detached-signature verification against trusted keys fetched from the
  registry). `--strict` additionally requires the server verdict, at least one
  valid signature, and a matching frozen-envelope artifact; the command exits
  non-zero when the publication does not verify.
- `registry-operator verify artifact (--sha256 <hex> | --artifact-urn <urn>)`
  — downloads the bytes from `GET /v1/artifacts/{sha256}` and re-hashes them,
  including the `Content-Digest` header when present; exits non-zero on
  mismatch.
- `registry-operator verify okta-config`
- `registry-operator verify browser-session`
- `registry-operator bootstrap test`

### Install / use as a CLI

The CLI is published as the npm package `@signet/registry-operator` with a
`registry-operator` bin.

Run without installing (npx):

```bash
npx @signet/registry-operator --help
```

Or install globally:

```bash
npm install -g @signet/registry-operator
registry-operator --help
```

A pre-built release tarball is also packaged under `release/` (via `npm pack`):

```bash
npm run build
npm pack --pack-destination release/
npm install -g release/signet-registry-operator-<version>.tgz
```

### Deployed environments (edge access)

Deployed API/MCP hosts may sit behind an edge access layer (for example
Cloudflare Access). Machines outside the trusted network pass a service token;
the CLI applies it to both the API and MCP clients:

```bash
export SIGNET_CF_ACCESS_CLIENT_ID=...
export SIGNET_CF_ACCESS_CLIENT_SECRET=...
export API_ORIGIN=https://signet-api.example.com
export MCP_ORIGIN=https://signet-mcp.example.com
```

Or per-invocation flags: `--cf-access-client-id`, `--cf-access-client-secret`.
See `docs/adoption.md`.

### Run locally

```bash
cd signet/client/registry-cli
npm install
npm run dev -- bootstrap test --reset --force --up
```

Default behavior:
- `bootstrap test` now points at the blessed first-user demo manifest
- default manifest: `examples/demo/demo.manifest.json`
- source-of-truth walkthrough: `../../docs/blessed-demo-path.md`
- CLI output now includes `graph_backend`, `cursor_mcp_config`, `next_prompts`, and token-safe artifact file paths
- when `--up` is used, the CLI now waits for `api`, `mcp`, and SPARQL/Fuseki readiness before seeding
- when `--reset` is used on a SPARQL-backed run, the CLI explicitly clears the dataset before bringing the stack back

### Richer bootstrap packs
The bootstrap manifest now supports:
- pack metadata
- reusable defaults
- multi-skill / multi-agent packs
- item ids and dependency ordering
- profile-based selection
- skill refs by `skill_item_id`, `skill_key`, or `skill_urn`
- `bootstrap test --lane okta-browser` for the real-Okta verification lane

Blessed demo dry run:

```bash
npm run dev -- bootstrap test --dry-run
```

Legacy example pack dry run:

```bash
npm run dev -- seed bootstrap --manifest examples/bootstrap/bootstrap.manifest.json --profile minimal --api-token "<token>" --dry-run
```

Blessed demo proof:

```bash
npm run dev -- bootstrap test --reset --force --up
```

Transparency sample graph proof:

```bash
npm run dev -- seed transparency-sample --api-token "<api-token>"
```

Canonical committed transparency sample spec:

```bash
npm run dev -- seed transparency-sample --spec examples/transparency/sample-graph.spec.json --dry-run
```

This prints the committed sample shape without requiring the stack or an API token.

Seed that same committed sample through the real operator path:

```bash
npm run dev -- seed transparency-sample --api-token "<api-token>" --spec examples/transparency/sample-graph.spec.json
```

Optional smaller human-facing report instead of the full JSON payloads:

```bash
npm run dev -- seed transparency-sample --api-token "<api-token>" --human-proof-report
```

Optional explicit sample id and day:

```bash
npm run dev -- seed transparency-sample --api-token "<api-token>" --sample-slug "demo" --day "2026-01-06"
```

What this command does:
- seeds trusted public keys, a transparency log, witnesses, checkpoints, observations, and gossip over the real API
- prints the seeded sample metadata plus the resulting log, verification, and timeline payloads by default
- with `--human-proof-report`, prints a smaller proof-oriented summary for humans instead of the full payloads
- uses the same trust-story shape exercised by the transparency sample-graph e2e tests
- can also seed the committed sample spec under `examples/transparency/sample-graph.spec.json`

### Real Okta bootstrap lane
The CLI now also supports a second operator lane for real Okta-backed bootstrap verification guidance.

It does not replace the browser flow.

Instead, it helps operators:
- validate the required API and webapp env/config state
- check stack health before the browser proof
- seed bootstrap content locally first if desired
- then follow the real browser-based proof documented in:
  - `service/webapp/knowledge-manager/OKTA_BROWSER_FLOW_RUNBOOK.md`

Example:

```bash
npm run dev -- verify okta-config
npm run dev -- verify browser-session
npm run dev -- bootstrap test --lane okta-browser --api-token "<api-token>" --mcp-token "<mcp-token>"
```

Important boundary:
- this Okta lane is for the registry-admin surface
- it does not change the current decision to defer real Okta-backed ontology access through the Semantic Turkey / VocBench companion runtime
