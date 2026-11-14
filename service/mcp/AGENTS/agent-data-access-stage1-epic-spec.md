# Agent Data Access Gateway — Stage 1 Epic Specifications

## Stage 1 mission
Deliver a production-safe first version that allows **Claude Code** and **Cursor** to use **read-only** tools against **Snowflake, Athena, and MotherDuck**, while giving the company a **full audit trail** of what agents do.

This document decomposes Stage 1 into build-ready epics.

---

# Stage 1 scope lock

## In scope
- Hono service
- official MCP TypeScript SDK
- Zod contracts
- OpenTelemetry
- Pino
- Stage 1 API key auth
- read-only tools:
  - `data.query`
  - `data.list_tables`
  - `data.describe_table`
- audit events persisted + logged
- Snowflake / Athena / MotherDuck connectors

## Out of scope
- Okta OAuth (Stage 2)
- writes
- data masking product
- full semantic data catalog
- generalized SQL parser for all dialects

---

# EPIC 0 — Contracts, schemas, and repo standards

## Goal
Freeze the canonical contracts before implementation spreads across routes, MCP definitions, and connectors.

## Deliverables
1. `ToolDefinition` model
2. canonical tool registry
3. Zod schemas for all Stage 1 tools
4. audit event schema
5. error code catalog
6. repo engineering standards

## Required decisions
- TypeScript `strict: true`
- `noUncheckedIndexedAccess: true`
- lint + formatting + test command wired in CI
- Hono version floor >= 4.10.2
- AWS SDK v3 only

## Tool definitions to create

### `data.query`
Input:
```ts
{
  data_source: "snowflake" | "athena" | "motherduck";
  sql: string;
  max_rows?: number;
  timeout_ms?: number;
}
```

Output:
```ts
{
  columns: Array<{ name: string; type?: string }>;
  rows: Array<Record<string, unknown>>;
  row_count_returned: number;
  truncated: boolean;
  warehouse_execution_id?: string;
  stats?: Record<string, unknown>;
}
```

### `data.list_tables`
Input:
```ts
{
  data_source: "snowflake" | "athena" | "motherduck";
  database?: string;
  schema?: string;
  pattern?: string;
  limit?: number;
}
```

### `data.describe_table`
Input:
```ts
{
  data_source: "snowflake" | "athena" | "motherduck";
  database: string;
  schema: string;
  table: string;
}
```

## Implementation notes
- Use Zod 4 as the contract source.
- Export JSON Schema snapshots for CI drift tests.
- Tool names should be canonical and stable:
  - `data.query`
  - `data.list_tables`
  - `data.describe_table`
- Tool names should not encode warehouse names because `data_source` is the dispatch field.

## Recommended files
```text
src/domain/tools/tool-names.ts
src/domain/tools/tool-definition.ts
src/domain/tools/tool-registry.ts
src/domain/audit/audit-event.ts
src/domain/errors/error-codes.ts
src/contracts/tools/*.ts
src/contracts/audit/*.ts
```

## Acceptance criteria
- `GET /v1/tools` can derive its response from the registry
- MCP tool list can derive from the same registry
- all tool schemas have unit tests and snapshots
- no tool contract duplicated in multiple files

## Tests
### Automated
- schema validity tests
- schema snapshot tests
- registry uniqueness test:
  - no duplicate tool names
- input contract tests:
  - valid input parses
  - invalid input rejects

### Manual
- developer can inspect generated schema docs locally

## Official references
- Zod: https://zod.dev/
- Hono RPC / type sharing: https://hono.dev/docs/guides/rpc
- MCP SDK quickstart and examples: https://github.com/modelcontextprotocol/typescript-sdk

---

# EPIC 1 — Core service skeleton and execution pipeline

## Goal
Create the modular monolith shell with a clean application pipeline that every adapter uses.

## Deliverables
1. Hono app bootstrap
2. request ID middleware
3. base logger
4. global error handling
5. `ExecuteToolUseCase`
6. `ListToolsUseCase`
7. dependency wiring / config loading
8. health endpoints

## Required routes
- `GET /healthz`
- `GET /readyz`
- `GET /v1/tools`
- `POST /v1/tools/{toolName}:execute`
- `ALL /mcp` (or route set required by the MCP HTTP transport)

## Hono requirements
- Use `requestId()` middleware
- attach a request-scoped logger to context
- attach principal to context after auth
- parse JSON with explicit body limits

## Important implementation note
There are recent Hono security advisories around body limit handling and JWT audience validation. Keep dependency minimums current.
- https://github.com/honojs/hono/security/advisories/GHSA-92vj-g62v-jqhh
- https://github.com/honojs/hono/security/advisories/GHSA-m732-5p4w-x69g

## Application pipeline shape
```text
route/adaptor
  -> auth middleware
  -> validation
  -> execute use case
      -> tool registry lookup
      -> policy decision
      -> connector execution
      -> output shaping
      -> audit publish
  -> response mapping
```

## `ExecuteToolUseCase` responsibilities
Inputs:
- tool name
- principal
- raw input
- request context (`request_id`, `client_name`, `trace_id`)

Steps:
1. resolve tool from registry
2. parse input with Zod
3. evaluate policy
4. execute tool handler
5. shape result under size/row/time limits
6. publish audit event
7. return canonical response envelope

## Error handling requirements
- all domain errors map to stable machine-readable error codes
- all failures still produce audit events where feasible
- response body must not leak stack traces or secrets

## Acceptance criteria
- one code path powers Tool API and MCP adapter
- healthz and readyz endpoints exist
- all route handlers are thin
- all cross-cutting concerns are middleware or ports

## Tests
### Automated
- Hono route tests using `app.request()`
- unit tests for `ExecuteToolUseCase`
- unit tests for error mapping
- unit tests for request-scoped logger creation

### Manual
- start local dev server
- `GET /healthz` returns 200
- tool list route returns canonical registry entries

## Official references
- Hono Node: https://hono.dev/docs/getting-started/nodejs
- Hono request ID: https://hono.dev/docs/middleware/builtin/request-id
- Hono RPC: https://hono.dev/docs/guides/rpc
- OpenTelemetry Node: https://opentelemetry.io/docs/languages/js/getting-started/nodejs/

---

# EPIC 2 — Stage 1 authentication with opaque API keys

## Goal
Provide a simple but safe Stage 1 auth mechanism that is easy for Claude Code and Cursor to use.

## Deliverables
1. API key data model
2. key issuance path (internal admin script or admin-only endpoint)
3. bearer auth middleware
4. principal mapping to `ApiKeyPrincipal`
5. auth failure audit behavior

## Design
### Why opaque keys
- fastest path to value
- works cleanly with remote MCP clients
- avoids early OAuth complexity
- can be fully replaced or co-exist with Okta in Stage 2

### Token format
Recommended:
```text
agk_<public_id>_<secret>
```

Persist:
- `public_id`
- `key_hash`
- `owner_label`
- `created_at`
- `revoked_at`

Do not persist the raw full token.

## Hono auth middleware behavior
- read `Authorization: Bearer <token>`
- reject if missing / malformed
- resolve API key by id
- verify hash
- attach `ApiKeyPrincipal` to request context

## Security requirements
- never log raw bearer tokens
- never return whether the key id exists
- constant-time hash comparison where practical
- revoked keys fail exactly like invalid keys

## Client onboarding
### Claude Code
Claude Code documents adding a remote HTTP MCP server and passing a bearer token in a header:
https://code.claude.com/docs/en/mcp

### Cursor
Cursor remote MCP configuration supports headers; use the same bearer model.

## Acceptance criteria
- valid key authenticates tool calls
- invalid / revoked / missing keys return 401
- denied auth attempts produce audit events
- tokens never appear in logs

## Tests
### Automated
- missing auth header -> 401
- malformed auth header -> 401
- invalid token -> 401
- revoked token -> 401
- token not present in logs/redacted fields

### Manual
- create a test key
- register MCP server in Claude Code with header
- execute a simple tool call

## Official references
- Claude Code MCP auth headers: https://code.claude.com/docs/en/mcp
- Pino redaction: https://github.com/pinojs/pino/blob/main/docs/redaction.md

---

# EPIC 3 — Warehouse connector ports and implementations

## Goal
Create one normalized connector port and three concrete implementations.

## Shared connector port
```ts
interface WarehouseConnector {
  listTables(input: ListTablesInput, ctx: ExecutionContext): Promise<ListTablesOutput>;
  describeTable(input: DescribeTableInput, ctx: ExecutionContext): Promise<DescribeTableOutput>;
  executeQuery(input: ExecuteQueryInput, ctx: ExecutionContext): Promise<ExecuteQueryOutput>;
}
```

## Shared connector rules
- connectors do not perform authorization
- connectors receive already-validated, already-authorized requests
- connectors must propagate timeouts
- connectors must return a warehouse execution id if available
- connectors must normalize rows and columns into the canonical output

---

## EPIC 3.1 — Snowflake connector

## Goal
Read-only Snowflake support with normalized outputs.

## Implementation notes
Use the Snowflake Node.js Driver:
- docs: https://docs.snowflake.com/en/developer-guide/node-js/nodejs-driver
- execute docs: https://docs.snowflake.com/en/developer-guide/node-js/nodejs-driver-execute

Important Snowflake note:
- Snowflake documents multi-statement support and notes the driver normally protects against multi-statement injection by erroring when multi-statement execution is not configured. Keep the connector in the default safe posture and do not enable multi-statement support for this service.

### Connection model
Use one dedicated service identity for Stage 1:
- read-only role
- warehouse limited to analytics workload
- explicit statement timeout if supported by session settings / connection config
- optional per-request query tag for traceability

### Data returned
Capture if available:
- Snowflake query id
- execution stats / row count metadata

### Recommended implementation steps
1. create connector config object
2. create connection factory
3. implement `executeQuery`
4. implement `listTables`
5. implement `describeTable`
6. normalize result row objects

## Acceptance criteria
- `SELECT 1` works in staging
- write/admin statements are blocked before driver call
- query id is captured in success path if available

## Tests
### Automated
- unit test connector result mapping
- unit test timeout propagation
- integration test against staging Snowflake

### Manual
- run `data.query` against a small staging table
- verify audit event contains Snowflake query id

---

## EPIC 3.2 — Athena connector

## Goal
Read-only Athena support using AWS SDK v3.

## Implementation notes
Use:
- `StartQueryExecution`
- `GetQueryExecution`
- `GetQueryResults`
- `StopQueryExecution` on timeout/cancel where appropriate

Official docs:
- StartQueryExecution: https://docs.aws.amazon.com/athena/latest/APIReference/API_StartQueryExecution.html
- GetQueryResults: https://docs.aws.amazon.com/athena/latest/APIReference/API_GetQueryResults.html
- AWS SDK v3 credentials in Node: https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html

### Security caveat
Athena docs warn that IAM principals with S3 permission to the query results location can retrieve results even if `GetQueryResults` is denied. Therefore:
- treat the S3 result location and its bucket policy as part of the connector security design
- use a dedicated output bucket/prefix and least-privilege IAM

### Connection / execution model
- dedicated workgroup
- dedicated output location
- default SDK credential provider chain in the runtime environment
- bounded polling with timeout

### Recommended implementation steps
1. define Athena client provider
2. implement `executeQuery`
3. poll until `SUCCEEDED` / `FAILED` / timeout
4. fetch results
5. normalize first row/column metadata carefully
6. implement timeout cancellation using `StopQueryExecution`
7. implement metadata tools using `information_schema` or catalog queries appropriate to your environment

## Acceptance criteria
- `SELECT 1` works in staging
- query execution id returned in output/audit
- timeout cancels or stops polling deterministically

## Tests
### Automated
- unit tests for polling state machine
- unit tests for result parsing
- integration tests against staging Athena workgroup and tiny table

### Manual
- force timeout scenario
- verify audit event contains Athena query execution id

---

## EPIC 3.3 — MotherDuck connector

## Goal
Read-only MotherDuck support using the official Node path documented by MotherDuck.

## Implementation notes
MotherDuck docs show Node examples with `@duckdb/node-api` and `DuckDBInstance.create("md:...")`.
Reference:
- https://motherduck.com/docs/key-tasks/authenticating-and-connecting-to-motherduck/connecting-to-motherduck/

Docs also state:
- the environment variable `motherduck_token` is auto-detected by the client
- `DuckDBInstance.fromCache(...)` can reuse cached instances
- `session_hint` and read scaling tokens exist

### Recommended service behavior
- prefer explicit connector config over relying on ambient lowercase env names
- use a dedicated token for the service
- evaluate instance caching for performance, but keep lifecycle simple in v1

### Recommended implementation steps
1. create MotherDuck connection factory
2. `DuckDBInstance.create("md:<db>")`
3. `instance.connect()`
4. `connection.runAndReadAll(sql)`
5. `reader.getRowObjects()`
6. implement list/describe queries against the appropriate metadata tables/views for your chosen database layout

## Acceptance criteria
- `SELECT 1` works
- connection failures are safe and never log token material
- result rows normalize to canonical structure

## Tests
### Automated
- unit tests for error mapping
- integration test with a staging MotherDuck database

### Manual
- verify connection and metadata tools

---

# EPIC 4 — SQL validation and result limits

## Goal
Prevent unsafe SQL from reaching connectors and keep tool results bounded.

## Deliverables
1. SQL validator
2. result size limiter
3. timeout/row cap policy merger
4. standard denial reasons

## Stage 1 validator rules
- single statement only
- allow only:
  - `SELECT ...`
  - `WITH ... SELECT ...`
- deny if contains forbidden top-level keywords:
  - `INSERT`, `UPDATE`, `DELETE`, `MERGE`
  - `CREATE`, `ALTER`, `DROP`, `TRUNCATE`
  - `GRANT`, `REVOKE`
  - `COPY`, `UNLOAD`
  - `CALL`, `PUT`, `GET`
  - `USE`, `SET`

### Important design note
Do not promise full SQL parsing fidelity in Stage 1.
Use a conservative validator and fail closed.
If the team wants comment support, add it deliberately after tests; simplest v1 is to deny SQL comments entirely.

## LIMIT strategy
Two acceptable approaches:
1. **Output truncation only**
   - simplest and safest
   - connector fetches result and the service trims to `max_rows`
2. **Wrapper LIMIT injection**
   - wrap user query in outer `SELECT * FROM (<user_sql>) AS _tool_query LIMIT N+1`
   - more efficient when supported
   - must be validated per dialect

Recommendation:
- v1: output truncation with connector-side fetch limits where cheap
- optionally add wrapper optimization later per connector

## Required limits
- `max_rows` default 50
- hard max 500
- `timeout_ms` default 15000
- hard max 60000
- `max_output_bytes` default 65536

## Acceptance criteria
- all mutating/admin statements are denied before connector call
- all responses are bounded
- all denials are audited

## Tests
### Automated
- `SELECT 1` allowed
- `WITH x AS (...) SELECT * FROM x` allowed
- `SELECT 1; SELECT 2` denied
- `DROP TABLE ...` denied
- `INSERT ...` denied
- oversized result is truncated and marked
- response payload never exceeds configured byte cap

### Manual
- run a very wide/large result query and confirm truncation behavior

---

# EPIC 5 — MCP adapter (thin, remote HTTP only)

## Goal
Expose the canonical tools to Claude Code and Cursor via the official MCP SDK using remote HTTP transport.

## Design requirements
- MCP is not the source of truth for tools
- MCP tool registration is generated from the canonical registry
- MCP handler delegates to the same `ExecuteToolUseCase`

## Official references
- MCP TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk
- MCP inspector: https://github.com/modelcontextprotocol/inspector
- Claude Code MCP docs: https://code.claude.com/docs/en/mcp
- Cursor MCP docs: https://docs.cursor.com/en/context/mcp

## Transport choice
Use remote HTTP / Streamable HTTP.
Do not invest in SSE unless compatibility testing forces it later.

## Implementation notes
The official MCP SDK examples show:
- `McpServer`
- tool registration using Zod schemas
- Streamable HTTP transport for remote servers

### Thin adapter rule
The MCP layer may:
- translate tool names and schemas
- map request context to the use case
- map result envelopes to MCP content

The MCP layer must not:
- query warehouses directly
- contain separate policy checks
- duplicate schemas

## Client-specific notes
### Claude Code
- remote HTTP is the documented choice for cloud MCP servers
- docs show passing custom headers including bearer auth
- `/mcp` is also used for OAuth authentication flows in Stage 2

### Cursor
- supports remote MCP config
- maintain a staging onboarding doc and smoke checklist because behavior evolves

## Acceptance criteria
- MCP `list_tools` reflects the canonical tool registry
- a tool call through MCP returns the same domain result envelope content as a Tool API execution
- Claude Code can register and call the server
- Cursor can register and call the server

## Tests
### Automated
- contract test: Tool API list == MCP tool registry list
- smoke test using MCP inspector or an SDK client
- response mapping tests for success and denial flows

### Manual
- Claude Code registration and one query
- Cursor registration and one query

---

# EPIC 6 — Audit persistence and operational reporting

## Goal
Make every call reviewable and queryable.

## Deliverables
1. audit event domain model
2. audit persistence store
3. structured logs
4. minimal reporting queries
5. correlation across logs, traces, and audits

## Audit event required fields
- `audit_id`
- `occurred_at`
- `request_id`
- `trace_id`
- `principal_type`
- `principal_id`
- `principal_display_name`
- `client_name`
- `tool_name`
- `tool_version`
- `data_source`
- `input_sha256`
- `input_preview_redacted`
- `policy_effect`
- `policy_reason`
- `limits_applied`
- `latency_ms`
- `rows_returned`
- `truncated`
- `warehouse_execution_id`
- `error_code`
- `error_message_safe`

## Logging rules
Use Pino with redaction for:
- `req.headers.authorization`
- `authorization`
- `cookie`
- any field matching token-like secret patterns

Do not log the raw SQL if security review objects.
Recommended compromise:
- store `input_sha256`
- store a short redacted preview
- optionally store full SQL only in the audit DB if the company explicitly wants it and security approves

## Reporting queries to support
- all executions by principal over time
- all executions against a given data source
- all denied attempts
- top tool calls by volume
- error rate by connector

## Acceptance criteria
- every allow/deny/failure writes an audit record
- audit persistence failures are visible in logs/alerts
- developers can correlate an audit record to a trace/log request

## Tests
### Automated
- unit test audit event builder
- integration test that success path persists audit
- integration test that deny path persists audit
- integration test that connector failure still persists audit

### Manual
- run one successful query and one denied query
- verify both appear in audit storage

---

# Stage 1 exit criteria
- Claude Code and Cursor can use the MCP server remotely
- all three connectors work in staging
- SQL safety checks deny writes/admin statements
- audit records exist for success and denial paths
- no raw credentials are logged
- service dashboards exist for:
  - latency
  - errors
  - calls per tool
  - denied attempts

---

# Stage 1 recommended sprint ordering

## Sprint A
- Epic 0
- Epic 1
- Epic 2

## Sprint B
- Epic 3.1 (Snowflake)
- Epic 4
- first vertical slice of `data.query`

## Sprint C
- Epic 5
- manual Claude/Cursor onboarding
- Epic 6 basics

## Sprint D
- Epic 3.2 Athena
- Epic 3.3 MotherDuck
- finish metadata tools
- hardening + perf + docs

---

# Stage 1 references
- Claude Code MCP: https://code.claude.com/docs/en/mcp
- Cursor MCP: https://docs.cursor.com/en/context/mcp
- MCP SDK: https://github.com/modelcontextprotocol/typescript-sdk
- Hono: https://hono.dev/
- OpenTelemetry JS: https://opentelemetry.io/docs/languages/js/
- Pino: https://github.com/pinojs/pino
- Snowflake Node driver: https://docs.snowflake.com/en/developer-guide/node-js/nodejs-driver
- Athena APIs: https://docs.aws.amazon.com/athena/latest/APIReference/Welcome.html
- MotherDuck Node docs: https://motherduck.com/docs/key-tasks/authenticating-and-connecting-to-motherduck/connecting-to-motherduck/
