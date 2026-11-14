# MCP Onboarding

How to connect any MCP-capable agent harness to the Cachet registry via
`service/mcp` (the AI-facing read plane).

- **Endpoint:** `http://localhost:3000/mcp` (Streamable HTTP transport)
- **Auth:** `Authorization: Bearer <token>` (Stage 1 API key)
- **Health:** `GET http://localhost:3000/healthz`

> **Deployed (security-prod):** `https://cachet-mcp.tunnel.together.ai/mcp`
> behind Cloudflare Access. See `adoption.md` for the CF-Access service-token
> headers required for non-WARP machine clients.

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
- `registry.get_agent` — get an agent and its linked entities
- `registry.list_skills` — list skills
- `registry.get_skill` — get a skill and its linked artifacts
- `registry.get_artifact` — fetch an artifact (content-addressed file)
- `registry.get_provenance` — PROV-O provenance chain and audit replay
- `registry.verify_publication` — verify a published version before use (envelope
  digests, frozen-envelope artifact, detached signatures, transparency proofs)
- `registry.get_attestations` — list attached DSSE/in-toto attestations (build
  provenance, SBOMs, scan results) with their verification status

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

Setting both gives a full default-deny posture. `registry.verify_publication`
is never gated: verification is how a reader discovers that something is
revoked or unverified.

### Data (warehouse, read-only)
- `data.query`
- `data.list_tables`
- `data.describe_table`

## 3. Harness config

### Claude Code

```bash
claude mcp add \
  --transport http \
  cachet-registry \
  http://localhost:3000/mcp \
  --header "Authorization: Bearer <token>" \
  --header "X-Agent-Client: claude-code"
```

### Cursor

Add to your MCP config (e.g. `~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "cachet-registry": {
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
    "cachet-registry": {
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
