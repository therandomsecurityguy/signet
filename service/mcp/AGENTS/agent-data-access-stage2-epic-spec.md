# Agent Data Access Gateway — Stage 2 Epic Specifications

## Stage 2 mission
Upgrade the Stage 1 system so that **the human user authenticates with Okta**, and the agent can only use data access that the human is already entitled to through Okta-defined permissions.

The key constraint is architectural:
- **do not change the canonical tools**
- **do not move business logic into MCP**
- **do not fork a separate policy path for OAuth callers**

Stage 2 is a control-plane upgrade, not a tool-contract rewrite.

---

# Stage 2 scope lock

## In scope
- Okta custom authorization server
- JWT access token validation in the Hono service
- MCP OAuth-compatible behavior for remote clients
- principal mapping to `OktaUserPrincipal`
- central authorization rules derived from Okta scopes/groups/claims
- audit enrichment with human identity

## Out of scope
- write tools
- full warehouse-native impersonation for every connector on day one
- dynamic client registration customization beyond what is necessary for supported clients
- replacing the canonical Tool API

---

# Stage 2 security truth model

## What “agent can only do what the human user can do” means in v2
The Stage 2 minimum viable truth is:

1. user authenticates with Okta
2. gateway validates the user’s access token
3. gateway evaluates authorization using Okta-derived claims/groups/scopes
4. gateway only permits tool calls and target objects that match those entitlements

This is a real and useful control plane, but it is not yet the strongest possible warehouse-native impersonation model.

## Stronger future maturity (not required in Stage 2)
Later, the team may strengthen enforcement by mapping the user/group to:
- Snowflake role selection / impersonation
- Athena IAM role assumption
- other source-native controls

That is a maturity path, not a prerequisite for Stage 2.

---

# EPIC 7 — Okta authorization server and application setup

## Goal
Create the Okta-side foundations needed for remote MCP clients and service-side token validation.

## Official references
- Okta auth servers overview: https://developer.okta.com/docs/concepts/auth-servers/
- Validate access tokens in Node: https://developer.okta.com/docs/guides/validate-access-tokens/nodejs/main/
- Okta JWT Verifier JS: https://github.com/okta/okta-jwt-verifier-js
- Claude Code MCP auth docs: https://code.claude.com/docs/en/mcp
- MCP auth spec: https://modelcontextprotocol.io/specification/2025-03-26/basic/authorization

## Required design choice
Use a **custom authorization server**, not the org authorization server, for protecting this API.

Why:
- Okta docs distinguish tokens for Okta’s own APIs from tokens intended for your APIs/resource servers
- your Hono service is a resource server that must validate access tokens

## Deliverables
1. custom authorization server
2. audience for the gateway API
3. scopes
4. claims
5. client app registrations as needed for supported MCP clients / deployment flow
6. environment-specific Okta config (dev/staging/prod)

## Recommended scopes
- `data.query.read`
- `data.catalog.read`

## Recommended claims
- `groups`
- `email`
- `preferred_username` if available
- optional dedicated entitlement claim if the org already models one

## Okta tasks
### 7.1 Create custom auth server
Decisions:
- issuer URL
- audience string (for example `api://agent-data-access`)
- token lifetime policy
- refresh token posture if used by the client flow

### 7.2 Configure scopes
Rules:
- do not use a single broad `*` scope
- keep Stage 2 scopes aligned with actual tool capabilities

### 7.3 Configure claims
At minimum the gateway needs:
- stable subject (`sub`)
- group or entitlement claim for authorization
- possibly email for operator-friendly audit logs

### 7.4 Register clients and redirect URIs
This will depend on the client flow supported by Claude Code and Cursor in your environment.
Because this area evolves quickly:
- validate client setup in staging
- keep a compatibility matrix document
- test whether pre-configured OAuth credentials are needed for Claude Code if dynamic registration is unavailable

## Acceptance criteria
- a test user can obtain an access token with the required audience/scope
- the token contains the expected claims
- Okta settings are documented per environment

## Tests
### Manual / integration
- acquire token for a staging user
- decode and verify claims
- verify expected audience and scopes

### Security review
- verify token lifetime policy
- verify least-privilege scopes
- verify group claims do not exceed practical token size limits

---

# EPIC 8 — JWT validation and principal mapping in the Hono service

## Goal
Make the service a correct OAuth resource server for Okta-issued access tokens.

## Official references
- Okta Node validation guide: https://developer.okta.com/docs/guides/validate-access-tokens/nodejs/main/
- Okta JWT verifier JS: https://github.com/okta/okta-jwt-verifier-js

## Deliverables
1. Okta JWT verifier integration
2. Hono middleware for bearer token validation
3. `OktaUserPrincipal`
4. auth mode selection / migration strategy from Stage 1
5. audit enrichment

## Architecture requirement
Authentication is still in middleware; authorization remains in the use case / policy service.

## Required validation
- signature via JWKS
- issuer
- audience
- expiration
- not-before if present
- required scopes

## Principal model
```ts
type OktaUserPrincipal = {
  type: "okta_user";
  id: string;              // sub
  email?: string;
  displayName?: string;
  scopes: string[];
  groups: string[];
  claims: Record<string, unknown>;
  authMethod: "okta_access_token";
};
```

## Middleware behavior
1. read bearer token
2. call Okta JWT verifier
3. validate expected audience
4. validate required base scopes
5. attach `OktaUserPrincipal` to context

## Migration approach
Recommended:
- support both Stage 1 API key auth and Stage 2 Okta auth behind config flags during migration
- choose auth mode per environment or per route group only if absolutely necessary
- prefer one route surface with multiple accepted auth modes during rollout, then deprecate API keys

## Acceptance criteria
- valid Okta token authenticates
- invalid/expired/wrong-audience token rejects
- audit records include Okta subject and user-facing identity fields where approved

## Tests
### Automated
- expired token -> 401
- wrong issuer -> 401
- wrong audience -> 401
- missing required scope -> 403 or 401 according to chosen semantics
- valid token -> principal attached

### Manual
- use a real staging Okta token against the service
- verify audit event contains `sub` and email if present

---

# EPIC 9 — MCP OAuth compatibility for remote clients

## Goal
Make the remote MCP surface behave correctly for OAuth-capable clients.

## Official references
- MCP auth spec: https://modelcontextprotocol.io/specification/2025-03-26/basic/authorization
- Claude Code MCP docs: https://code.claude.com/docs/en/mcp

## Why this epic exists
JWT validation alone is not enough.
Remote MCP clients may expect the server to advertise authorization behavior according to the MCP authorization spec.

## Deliverables
1. protected resource metadata endpoint(s)
2. 401 `WWW-Authenticate` challenges
3. documented resource server metadata
4. staging validation with Claude Code and Cursor

## Required endpoints
Implement the OAuth protected resource metadata required by the spec.

At minimum support:
- `/.well-known/oauth-protected-resource`
- and, if needed for tighter compliance, the path-scoped form associated with your MCP endpoint

The metadata should advertise:
- resource identifier
- authorization server(s) (Okta issuer / authorization server metadata URL)
- supported scopes as appropriate

## 401 behavior
When an unauthenticated client hits `/mcp`, return:
- `401 Unauthorized`
- `WWW-Authenticate: Bearer ...`
- pointers to resource metadata as described by the MCP/OAuth protected resource model

## PKCE and public clients
The MCP spec aligns with OAuth 2.1 guidance and requires PKCE for public clients.
That matters for user-driven login flows in tools like Claude Code and Cursor.

## Dynamic client registration
The spec encourages support, but in practice some environments use pre-configured clients.
Claude Code docs explicitly describe a pre-configured OAuth credentials flow when dynamic registration is unavailable.

## Acceptance criteria
- unauthenticated MCP requests return spec-aligned bearer challenge behavior
- supported clients can complete the login flow in staging
- authenticated MCP requests succeed without changing tool contracts

## Tests
### Automated
- request without token -> 401 + expected auth headers
- metadata endpoint -> valid JSON
- request with valid token -> succeeds

### Manual
- Claude Code OAuth login via `/mcp`
- Cursor OAuth login validation

### Documentation deliverable
- one pager for developers:
  - exact MCP endpoint
  - expected auth behavior
  - client setup caveats

---

# EPIC 10 — Authorization based on Okta claims/groups

## Goal
Enforce actual per-user permissions based on Okta-defined entitlements, without changing the tool contracts.

## Deliverables
1. policy config model
2. policy evaluation engine
3. SQL object extraction
4. authorization tests across multiple user/group combinations
5. audit details that explain deny reasons

## Minimal recommended v2 authorization model
Map Okta groups (or explicit entitlement claims) to:
- allowed tools
- allowed data sources
- allowed database/schema/table patterns

Example:
```yaml
rules:
  - id: analytics-read
    when:
      any_group: ["grp_analytics"]
    allow:
      tools: ["data.query", "data.list_tables", "data.describe_table"]
      data_sources:
        snowflake:
          databases: ["ANALYTICS"]
          schemas: ["PUBLIC", "CURATED"]
          tables: ["*"]
        athena:
          databases: ["analytics_db"]
          schemas: ["*"]
          tables: ["*"]
        motherduck:
          databases: ["analytics"]
          schemas: ["main"]
          tables: ["*"]
```

## Important policy rule
A valid token is not enough.
The service must also answer:
- is this tool allowed?
- is this data source allowed?
- are all referenced objects allowed?

## SQL object extraction
Stage 2 should add object extraction to inspect referenced tables/views in the query.

Recommendation:
- evaluate SQL parser options in design review for the three target dialect families
- if parser confidence is low for a query, fail closed or require a more restrictive rule
- keep parser integration isolated behind a port so it can change later

## Authorization semantics
Suggested order:
1. base authn success
2. required scope for tool family
3. tool allowlist
4. data source allowlist
5. object pattern checks
6. row/time/output limits

## Audit requirements
For every deny:
- record which policy rule failed
- record which object or source was disallowed
- return a safe denial reason to the client

## Acceptance criteria
- different Okta group memberships produce different authorization outcomes
- disallowed schemas/tables are denied even with a valid token
- audit explains the deny reason
- no connector call occurs after a deny

## Tests
### Automated
- allowed user/group -> allowed query
- disallowed user/group -> denied query
- mixed query referencing one allowed and one denied object -> deny
- metadata tools also respect data-source and object policy
- deny path writes audit event

### Manual
- staging users in at least three policy classes:
  - full analytics read
  - limited read
  - no data access

---

# Stage 2 rollout plan

## Rollout step 1
- deploy Okta validation in staging
- keep Stage 1 API keys enabled
- test both auth modes

## Rollout step 2
- enable MCP auth metadata/challenge behavior
- validate Claude Code and Cursor login flows

## Rollout step 3
- enable authorization based on Okta groups/claims
- test with real staging users and least-privilege data sets

## Rollout step 4
- deprecate or narrow Stage 1 API keys
- keep one break-glass admin path only if explicitly approved

---

# Stage 2 exit criteria
- remote MCP clients authenticate through Okta
- the service validates access tokens correctly
- authorization decisions are based on Okta-derived identity
- the canonical Tool API and Stage 1 connectors remain intact
- audit records identify the human user and explain policy decisions

---

# Stage 2 references
- Okta auth servers: https://developer.okta.com/docs/concepts/auth-servers/
- Okta access token validation in Node: https://developer.okta.com/docs/guides/validate-access-tokens/nodejs/main/
- Okta JWT verifier: https://github.com/okta/okta-jwt-verifier-js
- MCP auth spec: https://modelcontextprotocol.io/specification/2025-03-26/basic/authorization
- Claude Code MCP auth: https://code.claude.com/docs/en/mcp
