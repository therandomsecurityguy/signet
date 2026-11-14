# Agent Data Access Gateway — Deep Research Spec Pack

## What this pack is
This pack turns the earlier PRD + stage plans into implementation-grade specifications for the dev team.

It assumes the agreed architecture:

- **MCP is a thin adapter**
- over a **canonical internal Tool API**
- implemented first as a **single modular monolith**
- with **authentication at the Hono gateway/middleware layer**
- and **authorization/policy decisions in the application/service layer**

That split gives fast time-to-value now and avoids the expensive refactor later.

---

## Recommended stack

### Runtime
- **Node.js 20 LTS or 22 LTS**
- **TypeScript** with `strict: true`

### HTTP / app framework
- **Hono** on Node
- Use the Node adapter, not an edge runtime, because:
  - Snowflake’s Node driver is Node-oriented
  - MotherDuck’s Node examples use `@duckdb/node-api`
  - OpenTelemetry Node auto-instrumentation is straightforward in Node processes

Official docs:
- Hono Node server: https://hono.dev/docs/getting-started/nodejs
- Hono request ID middleware: https://hono.dev/docs/middleware/builtin/request-id

### MCP
- **Official TypeScript MCP SDK**
- Prefer **Streamable HTTP / remote HTTP**
- Do **not** build business logic inside the MCP server layer

Official docs:
- MCP TypeScript SDK repo: https://github.com/modelcontextprotocol/typescript-sdk
- MCP architecture/spec: https://modelcontextprotocol.io/docs/learn/architecture
- MCP auth spec: https://modelcontextprotocol.io/specification/2025-03-26/basic/authorization

### Validation / contracts
- **Zod 4**
- Use Zod as the canonical contract source for:
  - Hono request validation
  - internal Tool API validation
  - MCP tool input schema registration
  - generated JSON Schema snapshots for documentation and regression tests

Official docs:
- Zod 4: https://zod.dev/
- Hono RPC / typed routes: https://hono.dev/docs/guides/rpc

### Observability
- **OpenTelemetry** for traces/metrics context propagation
- **Pino** for structured JSON logs
- Correlate:
  - `request_id`
  - `trace_id`
  - `span_id`
  - `audit_id`

Official docs:
- OpenTelemetry JS for Node: https://opentelemetry.io/docs/languages/js/getting-started/nodejs/
- OpenTelemetry Node zero-code / auto instrumentation: https://opentelemetry.io/docs/zero-code/js/
- Pino: https://github.com/pinojs/pino
- Pino redaction: https://github.com/pinojs/pino/blob/main/docs/redaction.md
- Pino child loggers: https://github.com/pinojs/pino/blob/main/docs/child-loggers.md
- Pino transports: https://github.com/pinojs/pino/blob/main/docs/transports.md

### Identity / auth
- **Stage 1**: opaque bearer API keys
- **Stage 2**: **Okta OAuth access tokens** from a **custom authorization server**
- Validate access tokens in the service using **Okta JWT Verifier for Node**
- Important nuance:
  - user login may use OIDC semantics,
  - but **your API must validate OAuth access tokens**, not rely on ID tokens

Official docs:
- Okta auth servers overview: https://developer.okta.com/docs/concepts/auth-servers/
- Validate access tokens in Node: https://developer.okta.com/docs/guides/validate-access-tokens/nodejs/main/
- Okta JWT Verifier JS: https://github.com/okta/okta-jwt-verifier-js
- Okta MCP server concepts / least privilege guidance: https://developer.okta.com/docs/concepts/mcp-server/

### Warehouse / data connectors
- **Snowflake Node.js Driver**
- **AWS SDK v3** for Athena
- **@duckdb/node-api** for MotherDuck

Official docs:
- Snowflake Node.js driver: https://docs.snowflake.com/en/developer-guide/node-js/nodejs-driver
- Snowflake execute / query APIs: https://docs.snowflake.com/en/developer-guide/node-js/nodejs-driver-execute
- AWS Athena StartQueryExecution: https://docs.aws.amazon.com/athena/latest/APIReference/API_StartQueryExecution.html
- AWS Athena GetQueryResults: https://docs.aws.amazon.com/athena/latest/APIReference/API_GetQueryResults.html
- AWS SDK for JavaScript v3 credentials in Node: https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html
- MotherDuck connecting from Node: https://motherduck.com/docs/key-tasks/authenticating-and-connecting-to-motherduck/connecting-to-motherduck/

---

## Latest ecosystem notes that matter to this design

### Claude Code
Claude Code’s MCP docs currently recommend **HTTP for remote servers** and show passing a bearer token header during server registration. Claude Code also supports authenticating remote MCP servers via the `/mcp` command and warns on large MCP outputs; the threshold is documented as 10,000 tokens and configurable with `MAX_MCP_OUTPUT_TOKENS`. If a remote server does not support dynamic client registration, Claude Code documents a pre-configured OAuth credentials flow.  
References:
- https://code.claude.com/docs/en/mcp

### Cursor
Cursor documents MCP support for **stdio**, **SSE**, and **Streamable HTTP**, with OAuth support for remote servers. The product evolves quickly, so keep a staging compatibility checklist for every release.  
References:
- https://docs.cursor.com/en/context/mcp

### MCP auth
The current MCP authorization spec is aligned with **OAuth 2.1** patterns. It explicitly discusses:
- protected resource metadata
- authorization server metadata
- 401 + `WWW-Authenticate` challenges
- PKCE for public clients

That is why Stage 2 should not be “just validate JWTs”; it should also implement the MCP-facing auth behavior needed by remote MCP clients.  
References:
- https://modelcontextprotocol.io/specification/2025-03-26/basic/authorization

### AWS SDK choice
AWS SDK for JavaScript **v2 is end-of-support**. Use **v3** only.  
Reference:
- https://github.com/aws/aws-sdk-js

### Hono security floor
Set a minimum Hono version floor in the repo because there have been recent security advisories affecting middleware / auth behavior. Recommended minimum floor: **Hono >= 4.10.2**.  
References:
- https://github.com/honojs/hono/security/advisories/GHSA-92vj-g62v-jqhh
- https://github.com/honojs/hono/security/advisories/GHSA-m732-5p4w-x69g

---

## Answer to the “Okta at edge/gateway or service layer?” question

### Recommended now
- **Authentication in Hono middleware**
- **Authorization in the application/service layer**

Why:
1. The Hono process is your MCP server and Tool API surface.
2. You need the authenticated principal available to:
   - policy decisions
   - audit events
   - connector execution
3. You want one code path for:
   - direct Tool API calls
   - MCP calls delegated through the adapter

### If you add an external edge/API gateway later
That edge may:
- terminate TLS
- enforce IP controls / rate limits
- optionally validate JWTs

But the app should still either:
- validate the token itself, or
- only trust identity headers from the gateway if those headers are cryptographically or network-bound and impossible for arbitrary callers to spoof

Do **not** move authorization policy out of the service. The application layer owns:
- tool allow/deny
- data-source allow/deny
- schema/table pattern checks
- row/time/size limits
- audit semantics

---

## Read order for the dev team

1. `agent-data-access-platform-architecture-spec.md`
2. `agent-data-access-stage1-epic-spec.md`
3. `agent-data-access-stage2-epic-spec.md`
4. `agent-data-access-reference-implementation-recipes.md`

---

## Decisions locked for v1/v2

### Locked for v1
- Single service, modular monolith
- Hono + MCP SDK + Zod + OTel + Pino
- Remote HTTP MCP only
- Stage 1 API keys
- Read-only tools only:
  - `data.query`
  - `data.list_tables`
  - `data.describe_table`

### Locked for v2
- Okta custom auth server
- OAuth access tokens from the human user
- MCP protected resource metadata + bearer challenges
- Central policy map from Okta claims/groups to data-source and object permissions

### Explicitly deferred
- write tools
- full data catalog product
- generalized workflow engine
- distributed microservices
- connector-specific RBAC impersonation on day one
- prompt/resource-heavy MCP design; tools are the primary surface

---

## Acceptance at the end of Stage 2
- Claude Code and Cursor can connect to the remote MCP server
- users authenticate through Okta
- tool calls are read-only and policy-constrained
- the system can answer:
  - who called which tool
  - with which identity
  - against which data source
  - with what policy decision
  - and with which result metadata / warehouse execution id

---

## File index

### 1. Platform architecture
`agent-data-access-platform-architecture-spec.md`

### 2. Stage 1 execution spec
`agent-data-access-stage1-epic-spec.md`

### 3. Stage 2 execution spec
`agent-data-access-stage2-epic-spec.md`

### 4. Reference code / recipes
`agent-data-access-reference-implementation-recipes.md`
