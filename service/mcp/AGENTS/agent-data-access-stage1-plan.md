# Agent Data Access Layer — Stage 1 TPM + Eng Manager Plan

**Stage objective:** Enable data platform stakeholders to use company data from **Claude Code** and **Cursor** against **MotherDuck, Snowflake, and Athena**, in a strictly **read-only** manner, with full **auditability** of what the agents do.

**Planning stance:** Deliver the smallest useful production slice first. Keep the architecture ready for Stage 2 Okta without introducing avoidable complexity now.

---

## 1. Stage 1 outcome

At the end of Stage 1, we have:

- one company-owned remote HTTP MCP endpoint
- a canonical internal Tool API behind it
- read-only metadata and query tools
- connectors for MotherDuck, Snowflake, and Athena
- named user tokens for minimal identity attribution
- end-to-end audit logs for tool calls and query executions
- a deployment and runbook the team can operate

---

## 2. Stage 1 operating principles

1. **Modular monolith, not microservices.**  
   Keep one deployable, clear modules, clear seams.

2. **Land one vertical slice first.**  
   Build one source end-to-end first, then replicate with shared abstractions.

3. **Contracts before polish.**  
   Stable tool schemas matter more than fancy dashboards in v1.

4. **Read-only is a hard release gate.**  
   If any write path is possible, the stage is not done.

5. **Audit from day one.**  
   No “we will add logging later.”

6. **Prefer native client UX where possible.**  
   Use the agent clients as intended: remote HTTP MCP, simple config, minimal ceremony.

---

## 3. Delivery shape

## Recommended physical implementation
One deployable service with modules such as:

```text
/src
  /domain
  /application
  /adapters
    /mcp
    /http
    /auth
  /connectors
    /motherduck
    /snowflake
    /athena
  /infrastructure
    /audit
    /config
    /persistence
/tests
  /unit
  /contract
  /integration
  /e2e
```

## External interface
- MCP over remote HTTP for Cursor and Claude Code

## Internal interface
- canonical Tool API invocation service
- optional internal HTTP route for future-proofing, but same process is fine

---

## 4. Release slices

## Stage 1 v1 — MVP
Deliver the smallest production-worthy system that satisfies the stage goal.

### Must-have in Stage 1 v1
- remote HTTP MCP endpoint
- named token auth
- `platform.list_sources`
- `metadata.list_namespaces`
- `metadata.list_relations`
- `metadata.describe_relation`
- `query.execute_readonly_sql`
- source connectors for MotherDuck, Snowflake, Athena
- read-only SQL validator
- append-only audit events
- staging + production deployment
- smoke-tested in Cursor and Claude Code

## Stage 1 v2 — hardening
Improve reliability, discoverability, and operations without changing the core architecture.

### Target additions in Stage 1 v2
- `query.preview_relation`
- metadata search / cache
- richer dashboards or basic audit viewer
- rate limiting and concurrency controls
- improved error catalog and runbooks
- better truncation, pagination only if usage proves it necessary

---

## 5. Stage 1 exit criteria

The stage is complete when all of the following are true:

1. A pilot user can connect from **Cursor** and from **Claude Code** to the same company MCP endpoint.
2. The pilot user can inspect schemas and run a bounded read-only query in **all three** sources.
3. Every invocation is captured in audit with actor, client, tool, source, time, outcome.
4. Attempts to run write-like SQL are denied and audited.
5. On-call can investigate a failed or suspicious query end-to-end.
6. The MCP layer contains no source logic or policy logic.
7. The team has a rollout runbook, token issuance / revocation process, and break/fix guide.

---

## 6. Milestone order

Use milestone order, not calendar promises.

### M0 — foundations
- ADRs
- repo skeleton
- environment / config / secret strategy
- CI and test harness

### M1 — tool core
- canonical Tool API
- tool registry + schemas
- read-only validator
- stable error catalog

### M2 — first vertical slice
- one connector end-to-end
- audit events
- MCP adapter
- client smoke tests

### M3 — remaining connectors
- MotherDuck, Snowflake, Athena all live in staging
- contract and integration tests for all

### M4 — production pilot
- production deployment
- named token issuance
- staged onboarding
- runbooks

### M5 — Stage 1 v2 hardening
- metadata search/cache
- audit usability
- rate limits
- operational improvements

---

## 7. Epics, tasks, acceptance criteria, and tests

## Epic S1-E1 — Architecture foundations

### S1-E1-T1 — Write architecture ADRs
**Deliverable**
- ADR for “remote HTTP MCP + canonical Tool API + modular monolith”
- ADR for “read-only enforcement strategy”
- ADR for “named tokens in Stage 1, Okta in Stage 2”

**Acceptance criteria**
- ADRs reviewed by platform lead and security partner
- ADRs explicitly list what is *not* in the MCP adapter
- ADRs define the minimum viable auth story for Stage 1

**Tests**
- no code test; review gate required before implementation branches merge

### S1-E1-T2 — Establish repo and module boundaries
**Deliverable**
- repository layout by bounded context
- linting, type checks, formatting
- CI pipeline for unit + contract tests

**Acceptance criteria**
- code compiles from clean checkout
- modules are separated by responsibility, not framework layer alone
- a new tool can be added without touching connector code unless needed

**Tests**
- CI build
- lint / format
- package dependency rule test if available

### S1-E1-T3 — Define config and secret strategy
**Deliverable**
- environment schema
- secret source of truth
- source credentials model
- token signing / storage choice

**Acceptance criteria**
- no secret hardcoded anywhere
- local, staging, production config documented
- source credential rotation path documented

**Tests**
- startup config validation
- secret missing / malformed config failure tests

---

## Epic S1-E2 — Canonical Tool API and tool registry

### S1-E2-T1 — Define the canonical invocation envelope
**Deliverable**
- `ToolInvocationRequest`
- `ToolInvocationResponse`
- stable error envelope
- correlation id model

**Acceptance criteria**
- same envelope used by all tools
- same envelope can be called by MCP adapter or future non-MCP adapter
- errors are explicit and machine-readable

**Tests**
- schema validation tests
- golden snapshot tests for serialized envelopes

### S1-E2-T2 — Create the tool registry
**Deliverable**
- tool definitions as code
- version field
- ownership field
- risk level field

**Acceptance criteria**
- tools are registered from one place
- MCP tool exposure is generated from the registry, not handwritten ad hoc
- adding a new tool requires schema, description, and owner

**Tests**
- registry completeness test
- generated MCP schema snapshot tests

### S1-E2-T3 — Implement core application services
**Deliverable**
- application services for:
  - list sources
  - list namespaces
  - list relations
  - describe relation
  - execute readonly sql

**Acceptance criteria**
- application layer depends only on connector interfaces, not vendor SDKs
- services emit audit intents
- services accept principal and client context

**Tests**
- unit tests with fake connectors
- contract tests for input/output shape

### S1-E2-T4 — Define stable error codes
**Deliverable**
Examples:
- `AUTH_REQUIRED`
- `ACCESS_DENIED`
- `SOURCE_NOT_FOUND`
- `QUERY_NOT_READONLY`
- `RESULT_TRUNCATED`
- `SOURCE_TIMEOUT`
- `CONNECTOR_FAILURE`

**Acceptance criteria**
- every user-visible failure maps to a stable error code
- error messages are actionable and safe to expose to agent clients

**Tests**
- error mapping table tests
- MCP adapter error translation tests

---

## Epic S1-E3 — Read-only query policy

### S1-E3-T1 — Build SQL safety validator
**Deliverable**
- AST-based validator for source-native SQL
- one-statement check
- allowed statement set

**Acceptance criteria**
- only `SELECT` and `WITH ... SELECT` pass by default
- multi-statement input fails
- comments or whitespace cannot bypass checks

**Tests**
- positive cases:
  - plain select
  - select with where/order/limit
  - cte + select
- negative cases:
  - insert/update/delete
  - create/drop/alter/truncate
  - copy/unload/export/call
  - semicolon-smuggled second statement
  - transaction wrappers

### S1-E3-T2 — Enforce execution limits
**Deliverable**
- default row cap
- hard row cap
- default timeout
- hard timeout
- max response size

**Acceptance criteria**
- result cap is enforced even if SQL omits `limit`
- oversized responses are truncated deterministically
- timeouts surface stable errors and audit entries

**Tests**
- result truncation tests
- timeout tests with fake slow connector
- large payload contract tests

### S1-E3-T3 — Add source-level read-only protections
**Deliverable**
- read-only roles / credentials per source
- connector execution settings that prevent accidental writes where possible

**Acceptance criteria**
- even if validator regresses, source permissions still block writes
- connection model is documented per source

**Tests**
- integration tests proving write statements fail at source level
- configuration verification tests for read-only role / profile selection

### S1-E3-T4 — Query tagging
**Deliverable**
- connector API supports query tags / comments
- correlation id and actor metadata propagate to source

**Acceptance criteria**
- query tags appear in source-side logs where supported
- fallback comment strategy documented where tags are not supported

**Tests**
- integration verification for source-side metadata where available
- unit tests for generated tag payload

---

## Epic S1-E4 — Connector abstraction and first vertical slice

### S1-E4-T1 — Define connector interface
**Deliverable**
A clean interface such as:
- `list_namespaces`
- `list_relations`
- `describe_relation`
- `execute_readonly_sql`

**Acceptance criteria**
- no vendor-specific types cross into application layer
- canonical metadata model covers all three sources without overfitting

**Tests**
- interface contract tests
- fake connector compatibility tests

### S1-E4-T2 — Choose and implement the first source vertical slice
**Deliverable**
- one source working end-to-end through MCP
- metadata + readonly query
- audit events live

**Acceptance criteria**
- first source can be fully demoed from agent client to warehouse and back
- lessons learned are written before copying to other connectors

**Tests**
- full e2e test for the chosen first source
- manual smoke in Claude Code and Cursor

### S1-E4-T3 — Write anti-corruption mapping rules
**Deliverable**
- mapping from vendor objects to canonical `NamespaceRef`, `RelationRef`, `ColumnDefinition`

**Acceptance criteria**
- canonical model is stable
- source-specific quirks are isolated inside connectors

**Tests**
- mapping unit tests
- schema snapshot tests

---

## Epic S1-E5 — MotherDuck connector

### S1-E5-T1 — MotherDuck metadata support
**Deliverable**
- list namespaces
- list relations
- describe relation

**Acceptance criteria**
- metadata tools work in staging against a known test dataset
- source-specific quirks are documented

**Tests**
- integration tests with fixture database
- contract tests for metadata shape

### S1-E5-T2 — MotherDuck readonly query execution
**Deliverable**
- execute validated read-only SQL
- bounded result translation

**Acceptance criteria**
- source execution id is captured if available
- row caps and timeouts enforced

**Tests**
- integration tests for successful query
- denied query tests
- truncation tests

### S1-E5-T3 — MotherDuck observability hooks
**Deliverable**
- connector metrics
- source error mapping
- query tagging or comment fallback

**Acceptance criteria**
- failures are diagnosable from logs
- connector metrics appear in dashboards

**Tests**
- simulated failure tests
- metrics emission tests

---

## Epic S1-E6 — Snowflake connector

### S1-E6-T1 — Snowflake metadata support
**Deliverable**
- list namespaces
- list relations
- describe relation

**Acceptance criteria**
- metadata tools work in staging against a representative database
- warehouse, database, schema naming is normalized in canonical model

**Tests**
- integration tests
- mapping tests

### S1-E6-T2 — Snowflake readonly query execution
**Deliverable**
- execute validated read-only SQL with query tagging

**Acceptance criteria**
- read-only role or equivalent is enforced
- source execution id and query tag are captured when available

**Tests**
- successful query integration tests
- denied write attempt tests
- query tag verification where practical

### S1-E6-T3 — Snowflake cost / timeout guardrails
**Deliverable**
- connector-specific timeout and warehouse routing choices

**Acceptance criteria**
- long-running queries fail predictably
- connector does not silently escalate resource usage

**Tests**
- timeout tests
- config validation tests

---

## Epic S1-E7 — Athena connector

### S1-E7-T1 — Athena metadata support
**Deliverable**
- list namespaces
- list relations
- describe relation

**Acceptance criteria**
- Data Catalog path is mapped cleanly into canonical namespace model

**Tests**
- integration tests
- metadata mapping tests

### S1-E7-T2 — Athena readonly query execution
**Deliverable**
- execute validated read-only SQL
- bounded result mapping

**Acceptance criteria**
- output is bounded for agent-safe use
- source execution metadata is captured

**Tests**
- integration tests
- truncation tests
- denied query tests

### S1-E7-T3 — Athena cost controls
**Deliverable**
- sane workgroup / output / timeout choices
- documented bytes-scanned guardrail strategy if available in environment

**Acceptance criteria**
- the connector does not create uncontrolled cost paths
- operator guidance exists for source-side cost incidents

**Tests**
- config validation tests
- integration tests in bounded datasets

---

## Epic S1-E8 — MCP adapter and client compatibility

### S1-E8-T1 — Implement MCP tool exposure
**Deliverable**
- MCP server over remote HTTP
- tools generated from tool registry
- request translation into Tool API calls

**Acceptance criteria**
- MCP layer contains zero connector or policy logic
- tools are discoverable by clients
- MCP errors map to stable Tool API errors

**Tests**
- MCP protocol contract tests
- generated tool schema snapshot tests

### S1-E8-T2 — Cursor compatibility
**Deliverable**
- project and/or user-level Cursor config example
- successful tool invocation from Cursor against staging

**Acceptance criteria**
- connection flow documented
- tool approval behavior understood and documented
- pilot users can self-configure with the runbook

**Tests**
- manual smoke test checklist
- headless MCP client compatibility test
- config example validation

### S1-E8-T3 — Claude Code compatibility
**Deliverable**
- project-scoped `.mcp.json` example or equivalent onboarding steps
- successful tool invocation from Claude Code against staging

**Acceptance criteria**
- connection flow documented
- `/mcp` and approval behavior documented where relevant
- pilot users can self-configure with the runbook

**Tests**
- manual smoke test checklist
- headless MCP client compatibility test
- config example validation

### S1-E8-T4 — Backward compatibility harness
**Deliverable**
- automated compatibility tests independent of actual UI
- mock MCP client or SDK-based contract runner

**Acceptance criteria**
- MCP compatibility can be regression tested in CI
- UI-only manual testing is not the sole verification strategy

**Tests**
- CI e2e against running local service

---

## Epic S1-E9 — Auditability and observability

### S1-E9-T1 — Define audit event schema
**Deliverable**
- `ToolInvocationAuditEvent`
- `SourceQueryAuditEvent`
- `PolicyDecisionAuditEvent` (even if policy is simple in Stage 1)

**Acceptance criteria**
- one schema version per event type
- schemas are documented and queryable

**Tests**
- schema validation tests
- append-only persistence tests

### S1-E9-T2 — Persist append-only audit records
**Deliverable**
- durable audit store
- restricted storage for detailed query text if retained
- correlation id indexing

**Acceptance criteria**
- every invocation writes an audit event on success, denial, and failure
- audit write failures surface loudly

**Tests**
- success-path audit tests
- denied-path audit tests
- failure-path audit tests
- “audit store unavailable” behavior tests

### S1-E9-T3 — Add metrics, tracing, and dashboards
**Deliverable**
- request count, failure count, latency, connector metrics
- trace propagation from MCP call to source connector
- basic operational dashboard

**Acceptance criteria**
- operators can answer “is it broken, where, and for whom?”
- dashboards separate gateway latency from source latency

**Tests**
- metrics emission tests
- trace propagation tests
- synthetic smoke test dashboard validation

### S1-E9-T4 — Basic audit reporting
**Deliverable**
- saved queries or lightweight report showing:
  - who invoked what
  - what source was touched
  - success vs denied vs failed

**Acceptance criteria**
- security / platform owners can answer common audit questions without raw log spelunking

**Tests**
- reporting query tests against fixture audit data

---

## Epic S1-E10 — Stage 1 auth, deployment, and rollout

### S1-E10-T1 — Implement named personal tokens
**Deliverable**
- token issuance script or admin flow
- token revocation support
- token-to-user mapping

**Acceptance criteria**
- every production request is attributable to a named human
- shared team tokens are not needed for pilot usage
- token rotation path exists

**Tests**
- valid token auth tests
- missing / malformed token tests
- revoked token tests

### S1-E10-T2 — Deploy staging and production
**Deliverable**
- HTTPS endpoint
- secret management
- health checks
- deployment runbook
- rollback runbook

**Acceptance criteria**
- service can be promoted between environments consistently
- no environment-specific code branches

**Tests**
- smoke tests after deployment
- health endpoint tests
- rollback drill checklist

### S1-E10-T3 — Pilot onboarding
**Deliverable**
- onboarding guide
- approved user list
- support process
- feedback collection loop

**Acceptance criteria**
- first pilot users can connect without engineer pair-programming every step
- onboarding and break/fix issues are captured as backlog items

**Tests**
- pilot checklist completion
- dry-run onboarding with non-implementer user

### S1-E10-T4 — Security review gate
**Deliverable**
- short security checklist
- read-only proof points
- audit proof points
- token handling review

**Acceptance criteria**
- security partner signs off for pilot
- known risks are documented with owners

**Tests**
- checklist completion
- evidence links present

---

## Epic S1-E11 — Stage 1 v2 hardening

### S1-E11-T1 — Add `query.preview_relation`
**Deliverable**
- preview tool with tiny bounded results

**Acceptance criteria**
- preview is safer and cheaper than arbitrary SQL for simple inspection
- agents can discover a table without writing SQL immediately

**Tests**
- contract tests
- connector integration tests

### S1-E11-T2 — Metadata cache and/or search
**Deliverable**
- optional cache for schemas/tables
- optional metadata search tool if justified

**Acceptance criteria**
- improved discovery performance without changing core contracts
- cache invalidation approach is simple and documented

**Tests**
- cache hit/miss tests
- stale data tolerance tests

### S1-E11-T3 — Rate limiting and concurrency controls
**Deliverable**
- simple per-token and/or global limits

**Acceptance criteria**
- one runaway agent session cannot monopolize the service
- rate limit errors are deterministic and audited

**Tests**
- load tests
- rate limit tests
- fairness tests if implemented

### S1-E11-T4 — Audit usability improvements
**Deliverable**
- lightweight audit viewer or easier saved reports
- clearer denied/failure reason surfacing

**Acceptance criteria**
- platform owners do not need ad hoc SQL for every common audit question

**Tests**
- fixture-based UI/query tests
- acceptance test with ops stakeholder

---

## 8. Test strategy

## Test layers

### Unit tests
Use for:
- domain invariants
- SQL validator
- mapping logic
- error mapping
- token validation logic

### Contract tests
Use for:
- Tool API request/response schemas
- MCP tool definitions
- audit event schemas
- connector interface compliance

### Integration tests
Use for:
- MotherDuck connector against test database
- Snowflake connector against staging warehouse
- Athena connector against staging catalog/workgroup
- audit store persistence
- auth/token verification

### End-to-end tests
Use for:
- MCP request -> Tool API -> connector -> audit round trip
- one success path per source
- one denied query path per source
- one connector failure path

### Manual smoke tests
Use for:
- Cursor user flow
- Claude Code user flow
- approval UX observations
- onboarding validation

## Must-pass Stage 1 test catalog

### S1-TEST-001
`platform.list_sources` returns the expected sources for a valid token.

### S1-TEST-002
`metadata.describe_relation` works for one known table in each source.

### S1-TEST-003
`query.execute_readonly_sql` returns bounded results for one known query in each source.

### S1-TEST-004
A multi-statement query is denied with `QUERY_NOT_READONLY`.

### S1-TEST-005
A DDL or DML statement is denied and audited.

### S1-TEST-006
A source timeout returns a stable error and an audit event.

### S1-TEST-007
Every invocation produces both traceable logs and audit events.

### S1-TEST-008
Missing token returns `AUTH_REQUIRED`.

### S1-TEST-009
Revoked token cannot invoke any tool.

### S1-TEST-010
Cursor can connect and invoke at least one metadata tool and one query tool.

### S1-TEST-011
Claude Code can connect and invoke at least one metadata tool and one query tool.

### S1-TEST-012
The MCP adapter can be changed without changing connector tests, proving separation of concerns.

---

## 9. Definition of done for any task

A task is not done until all of the following exist:

- implementation
- automated tests at the right layer
- logging / metrics / audit additions if relevant
- docs or runbook updates if the task changes operator or user behavior
- code review from the owning domain lead
- no leaked vendor types into the wrong layer
- no hidden behavior that only exists in prompts or tribal knowledge

---

## 10. Risks and mitigations

### Risk: connector abstraction becomes too generic and clumsy
**Mitigation:** keep the canonical model small; allow source-native SQL; do not over-normalize.

### Risk: audit logs store too much sensitive query detail
**Mitigation:** separate operational logs from restricted audit detail; default to fingerprints and encrypted detailed storage.

### Risk: Stage 1 token model becomes sticky and blocks Stage 2
**Mitigation:** make principal an explicit domain concept now; keep auth behind an interface; do not bake token semantics into tools.

### Risk: client quirks dominate architecture
**Mitigation:** test real Cursor and Claude Code flows early, but keep the canonical core client-agnostic.

### Risk: rollout stalls on all-three-connectors complexity
**Mitigation:** land one connector vertical slice first, then replicate.

---

## 11. Recommended minimal squad

- **1 tech lead / principal engineer** for architecture and code review
- **2 backend/platform engineers** for Tool API, MCP adapter, audit, and deployment
- **1 data/platform engineer** shared or partial for source credentials and connector details
- **1 TPM / EM owner** coordinating dependencies, pilot, and release gates
- **security partner** as required for review, not full-time embedded

---

## 12. Handoff checklist to start implementation

Before coding starts, confirm these inputs exist:

- read-only credentials / roles for MotherDuck, Snowflake, Athena
- staging datasets for safe integration tests
- hostname / TLS plan for the MCP endpoint
- secret store choice
- audit storage choice
- first pilot user list
- decision on first source vertical slice

---

## 13. Reference assumptions from current official docs

- Claude Code supports remote HTTP MCP, local stdio, and OAuth for remote servers; project-shared MCP config lives in `.mcp.json`.  
  <https://docs.anthropic.com/en/docs/claude-code/mcp>

- Cursor supports remote `Streamable HTTP`, `SSE`, and local `stdio` transports for MCP, with OAuth support for remote servers and approval controls for tools.  
  <https://docs.cursor.com/en/context/mcp>

- MCP’s authorization guidance is OAuth 2.1 / PKCE oriented for HTTP transports.  
  <https://modelcontextprotocol.io/specification/2025-03-26/basic/authorization>
