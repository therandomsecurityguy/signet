# Adopting Signet (deployed)

How to connect to a deployed **Signet registry** and adopt it:
register agents/skills, discover them, and verify trust.

For local development see `local-development.md`; for the full API surface see
`api-reference.md`. This doc covers a deployed environment.

## Surfaces

| Surface | URL | Auth | Audience |
|---|---|---|---|
| Webapp (human UI) | `https://signet.example.com` | OIDC (browser) | Humans |
| Registry API (`/v1`) | `https://signet-api.example.com` | OIDC bearer **or** `agk_` API key | SDK / CLI / operators |
| MCP gateway | `https://signet-mcp.example.com/mcp` | `agk_` API key | Agents / MCP clients |

- OpenAPI 3.1: `GET https://signet-api.example.com/v1/openapi.json`
- Swagger UI: `https://signet-api.example.com/v1/docs`

Replace `example.com` hosts with your deployment's domains. A common setup
puts all three behind an edge access layer (for example Cloudflare Access)
with internal-only routing.

## Two auth layers (both required in that setup)

1. **Edge access** (network):
   - **Humans:** a device enrolled in your edge provider's zero-trust org.
   - **Machines:** an edge **service token** — send
     `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers on every request.
2. **Application auth** (`AUTH_MODE=dual`):
   - **Humans / webapp:** OIDC (group RBAC: `app_signet_admin`, `app_signet_viewer`).
   - **Machines:** an API key beginning with `agk_`, sent as
     `Authorization: Bearer agk_…`.

So a machine request carries **both** the edge service-token headers and
the API-key bearer.

## Get credentials

### 1. Edge service token (machines)

Issue a service token in your edge provider (for example a Cloudflare Access
service token scoped to the Signet hosts) and retrieve its client id/secret
from that provider or your IaC outputs:

```
signet_machines_service_token_client_id
signet_machines_service_token_client_secret   # sensitive
```

Store the secret in your secret manager (never in shell history),
then send it on **every** request to the deployment:

```
CF-Access-Client-Id: <client_id>
CF-Access-Client-Secret: <client_secret>
```

Rotate by re-issuing the token in the provider and updating client configs.

### 2. API key (`agk_`)

**Self-serve (preferred).** Any principal in `app_signet_admin` mints keys via
the API (edge service-token headers required from outside the trusted network):

```bash
curl -s -X POST https://signet-api.example.com/v1/api-keys \
  -H "CF-Access-Client-Id: $CF_ID" \
  -H "CF-Access-Client-Secret: $CF_SECRET" \
  -H "Authorization: Bearer <okta-access-token>" \
  -H 'content-type: application/json' \
  -d '{"owner_label":"agent-x","scopes":["read","write"]}'
# -> { "token": "agk_…", "api_key": { "key_id": "…", "scopes": ["read","write"], "expires_at": "…" } }
```

The secret is returned **once**; list metadata with `GET /v1/api-keys`, rotate
with `POST /v1/api-keys/{keyId}/rotate`, revoke with
`DELETE /v1/api-keys/{keyId}`.

**Operator fallback** (no Okta available, e.g. bootstrapping):

```bash
cd service/api && npm ci
DATABASE_URL='<prod-database-url>' npm run create-api-key -- --owner-label "agent-x" --scopes read,write
```

Use the token as `Authorization: Bearer agk_…`. Scopes are
`read` / `write` / `lifecycle` (default `read`); scoped keys need a write-capable
scope for write methods; keys expire after `API_KEY_DEFAULT_TTL_DAYS` unless a
`ttl_days` is given.

## Quickstarts

### API (curl, machine)

```bash
export CF_ID=<signet-machines client id>
export CF_SECRET=<signet-machines client secret>
export SIGNET_KEY=agk_…

# Verified: returns 200 with a valid service token + key; 302 without the
# service token; 401 with a bad key.
curl -s https://signet-api.example.com/v1/session \
  -H "CF-Access-Client-Id: $CF_ID" \
  -H "CF-Access-Client-Secret: $CF_SECRET" \
  -H "Authorization: Bearer $SIGNET_KEY"

curl -s https://signet-api.example.com/v1/skills \
  -H "CF-Access-Client-Id: $CF_ID" \
  -H "CF-Access-Client-Secret: $CF_SECRET" \
  -H "Authorization: Bearer $SIGNET_KEY"
```

### SDK (`@signet-registry/sdk`)

Pass the CF-Access headers via the `headers` option:

```ts
import { RegistryClient } from '@signet-registry/sdk';

const client = new RegistryClient({
  baseUrl: 'https://signet-api.example.com',
  apiToken: process.env.SIGNET_KEY,
  headers: {
    'CF-Access-Client-Id': process.env.SIGNET_CF_ACCESS_CLIENT_ID!,
    'CF-Access-Client-Secret': process.env.SIGNET_CF_ACCESS_CLIENT_SECRET!,
  },
});

const skills = await client.listSkills();
```

(If you prefer, the client also accepts a custom `fetch` that injects the same headers.)

### CLI (`@signet-registry/operator`)

Set the Cloudflare Access service-token headers as env vars (applied to both the
API and MCP clients):

```bash
export SIGNET_CF_ACCESS_CLIENT_ID=...
export SIGNET_CF_ACCESS_CLIENT_SECRET=...
export API_ORIGIN=https://signet-api.example.com
export MCP_ORIGIN=https://signet-mcp.example.com

registry-operator verify api --manifest ./bootstrap.json --api-token agk_...
```

Or pass them per invocation with `--cf-access-client-id` / `--cf-access-client-secret`.

### MCP (Streamable HTTP)

```bash
# Claude Code
claude mcp add --transport http signet-registry \
  https://signet-mcp.example.com/mcp \
  --header "Authorization: Bearer $SIGNET_KEY" \
  --header "CF-Access-Client-Id: $CF_ID" \
  --header "CF-Access-Client-Secret: $CF_SECRET" \
  --header "X-Agent-Client: claude-code"
```

Generic MCP config (opencode / Cursor) uses the same URL and headers:

```json
{
  "mcp": {
    "signet-registry": {
      "type": "remote",
      "url": "https://signet-mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer agk_…",
        "CF-Access-Client-Id": "…",
        "CF-Access-Client-Secret": "…",
        "X-Agent-Client": "opencode"
      }
    }
  }
}
```

## Adopt (publish) an agent or skill

1. **Discover** — `registry.search` / `GET /v1/skills` to check for duplicates.
2. **Create** — `POST /v1/skills` (or `/v1/agents`) with the artifact bytes
   (content-addressed CAS) — requires an admin principal.
3. **Validate → publish → certify** — the lifecycle endpoints
   (`…/versions/:v/validate|publish|certify`); validation failures are recorded
   and gate the transition.
4. **Verify** — `GET …/versions/:v/provenance` (PROV-O) and the transparency log
   endpoints to confirm the certification/evidence chain.

See `governance-model.md` and `quick-value-roadmap.md` for the full model.

## Verify-then-load contract (for agents)

Consumers must not trust a publication just because the registry served it.
Verify before you load, in this order:

1. **Resolve, don't guess** — `registry.search` to find candidates, then pin an
   explicit version (never treat "latest" as a trust decision).
2. **Verify the publication** — `registry.verify_publication` (MCP) or
   `GET …/versions/:v/verification`. Require `verification_status: verified`;
   when a frozen envelope artifact is present, require
   `publication_envelope_artifact_sha256_matches: true`. Live drift
   (`live_envelope_matches_frozen_artifact: false`) is expected after evidence
   is attached and does not invalidate the published bytes.
3. **Reproduce the verdict locally** — with `@signet-registry/sdk`:
   `verifyEnvelopeSignatures` recomputes the canonical JSON digest and checks
   every detached signature against trusted keys (fetch their PEM from CAS with
   `fetchArtifact`). Offline equivalents for the CLI:
   `registry-operator verify publication (--skill|--agent) --version <n> [--strict]`.
4. **Check the evidence** — `registry.get_attestations` for build provenance
   and SBOMs; `registry.get_provenance` for the certification/evidence chain.
   Policies can require these at certification
   (`require_signature`, `require_trusted_publisher`, `require_build_provenance`,
   `require_sbom`).
5. **Load bytes that hash** — `registry.get_artifact` (MCP) or
   `GET /v1/artifacts/{sha256}`; both surface digest verdicts, and the SDK's
   `fetchArtifact` re-hashes locally (`digest_verified: false` means do not
   use them). The CLI equivalent is
   `registry-operator verify artifact (--sha256|--artifact-urn)`.
6. **Only then use it** — and re-run verification when a version changes.

Environment-level enforcement is available when consumers cannot be trusted to
check: the MCP read gates (`REGISTRY_READ_DENY_REVOKED` on by default,
`REGISTRY_READ_REQUIRE_VERIFIED` opt-in) deny revoked or unverified
publications before they leave the read plane.

See `supply-chain-model.md` for how this maps onto the wider supply-chain
security model.

## Known gaps / follow-ups

- **Service-token rotation**: re-issue the `signet-machines` token in your edge
  provider and update client configs.

## Related

- `api-reference.md` — management-plane API
- `mcp-onboarding.md` — MCP tools and harness config
- `client/registry-sdk/README.md` — typed SDK
- `client/registry-cli/README.md` — operator CLI
