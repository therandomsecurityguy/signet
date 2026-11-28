# MCP Onboarding

How to connect any MCP-capable agent harness to the Signet registry via
`service/mcp` (the AI-facing read plane).

- **Endpoint:** `http://localhost:3000/mcp` (Streamable HTTP transport)
- **Auth:** `Authorization: Bearer <token>` (Stage 1 API key)
- **Health:** `GET http://localhost:3000/healthz`

> **Deployed:** `https://signet-mcp.example.com/mcp`
> behind Cloudflare Access. See `adoption.md` for the CF-Access service-token
> headers required for machine clients outside the edge access layer.

## 1. Create an API key

```bash
cd service/mcp
npm run create-api-key -- --owner-label "Jane Doe"
```

Use the returned token as the bearer token in your harness config.

## 2. Available tools

All tools are read-only. The canonical list is the source of truth
(`service/mcp/src/domain/tools/tool-registry.ts`).

### Registry (discovery / load / trust)
- `registry.search` — search skills and agents by name, key, or description
- `registry.list_agents` — list agents
- `registry.get_agent` — get an agent and its linked entities, including a
  `trust_summary` for the active version
- `registry.list_skills` — list skills
- `registry.get_skill` — get a skill and its linked artifacts, including a
  `trust_summary` for the active version
- `registry.get_artifact` — fetch an artifact (content-addressed file)
- `registry.get_provenance` — PROV-O provenance chain and audit replay
- `registry.verify_publication` — verify a published version before use (envelope
  digests, frozen-envelope artifact, detached signatures, transparency proofs)
- `registry.get_attestations` — list attached DSSE/in-toto attestations (build
  provenance, SBOMs, scan results) with their verification status

### Resources

Harnesses can attach registry content natively instead of copying bodies out of
tool responses:

- `resources/templates/list` exposes `signet://skill/{skill_key}` and
  `signet://agent/{agent_key}`; reading one returns the **active version's
  body** (mimeType from the artifact), fetched through the exact same tool
  execution path — so read gates (revoked/publication-verification), artifact
  digest verification, and audit all apply. A body that fails verification is
  refused, never served.
- `resources/list` exposes `signet://index` — a JSON catalog of published
  skills and agents with their resource URIs, for discovery in one read.

Example resource attach (Claude Code / Cursor style):

```json
{ "mcpServers": { "signet": { "url": "http://localhost:3000/mcp",
  "headers": { "Authorization": "Bearer <mcp token>" } } } }
```

then reference `signet://skill/skill:registry-mcp` as a resource.

### Read gates

Two environment flags harden the read path:

- `REGISTRY_READ_DENY_REVOKED` — **on by default**: `registry.get_skill`,
  `registry.get_agent`, and `registry.get_artifact` refuse revoked publications
  (`REGISTRY_READ_DENIED_REVOKED`). An artifact is refused when every
  publication referencing it is revoked. Set it to `false` only to restore the
  legacy fail-open behaviour.
- `REGISTRY_READ_REQUIRE_VERIFIED` — **opt-in** (`true`): the same tools refuse
  publications whose verification does not pass
  (`REGISTRY_READ_DENIED_UNVERIFIED`). An artifact is refused when no live
  referencing publication verifies. Whether verification strictness is required
  is a deployment policy, so it stays opt-in.

Setting both gives a full default-deny posture. Enumeration paths are filtered
too: `registry.search` and `registry.list_skills` / `registry.list_agents`
omit entries whose active publication is denied by the enabled gates, so a
denied publication is not discoverable through search or listing.
`registry.verify_publication` is never gated: verification is how a reader
discovers that something is revoked or unverified.

### Data (warehouse, read-only)
- `data.query`
- `data.list_tables`
- `data.describe_table`

Before the first data call, `GET /v1/data-sources` reports each approved
source's mode (`mock`/`real`) and readiness (`missing_config` names, never
values). Sources default to `mock` locally with deterministic answers, so
the whole path works before any warehouse credentials exist. The full
golden path — readiness → list → describe → query, per source, with demo
prompts and troubleshooting — is in `docs/mcp-data-access.md`.

## 3. Harness config

### Claude Code

```bash
claude mcp add \
  --transport http \
  signet-registry \
  http://localhost:3000/mcp \
  --header "Authorization: Bearer <token>" \
  --header "X-Agent-Client: claude-code"
```

### Cursor

Add to your MCP config (e.g. `~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "signet-registry": {
      "url": "http://localhost:3000/mcp",
      "headers": {
        "Authorization": "Bearer <token>",
        "X-Agent-Client": "cursor"
      }
    }
  }
}
```

### opencode

Add to your opencode config (e.g. `opencode.json`):

```json
{
  "mcp": {
    "signet-registry": {
      "type": "remote",
      "url": "http://localhost:3000/mcp",
      "headers": {
        "Authorization": "Bearer <token>",
        "X-Agent-Client": "opencode"
      }
    }
  }
}
```

### Generic MCP client

Use the Streamable HTTP transport against `http://localhost:3000/mcp` with the
`Authorization: Bearer <token>` header. The server speaks the MCP protocol
over HTTP; any MCP client that supports remote HTTP servers can connect.

## 4. First-prompt pattern (self-orientation)

Once connected, a fresh agent can self-orient using the discovery tools:

1. **Discover** — `registry.search` with a query (e.g. "llama", "infra", "review")
2. **Inspect** — `registry.get_skill` / `registry.get_agent` for details
3. **Load** — `registry.get_artifact` for the implementation bytes
4. **Trust** — `registry.verify_publication` for the digest/signature/transparency
   verdict, and `registry.get_provenance` for the certification/evidence chain

Example prompt for a connected agent:

> "Use `registry.search` to find skills related to 'infra bootstrap', then
> `registry.get_skill` to inspect the top match, `registry.get_artifact` to
> load its implementation, and `registry.get_provenance` to check its
> certification status before using it."

## 5. Auth modes

- **Stage 1 (default):** `AUTH_MODE=api_key` — opaque bearer API keys
- **Stage 2 (mock-first):** `AUTH_MODE=okta` + `OKTA_MODE=mock` — any bearer token accepted
- **Dual:** `AUTH_MODE=dual` — tokens starting with `agk_` are API keys; others are Okta

In Okta mode, unauthenticated `/mcp` requests include a `WWW-Authenticate`
challenge pointing at the protected resource metadata endpoint
(`GET /.well-known/oauth-protected-resource`).

## Related

- `service/mcp/README.md` — operator guide and local setup
- `docs/api-reference.md` — the management-plane API (writes, lifecycle)
- `client/registry-sdk/README.md` — typed SDK for programmatic reads
