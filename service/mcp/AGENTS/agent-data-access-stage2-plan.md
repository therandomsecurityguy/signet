# Agent Data Access Layer — Stage 2 TPM + Eng Manager Plan

**Stage objective:** Upgrade the Stage 1 solution so that agent access is authenticated with **Okta OAuth of the human user**, and the agent can only do what that human user is allowed to do according to Okta-defined access.

**Planning stance:** Preserve the Stage 1 tool contracts. Add identity and authorization in the canonical core, not in the MCP adapter, and do it with the minimum extra system surface necessary.

---

## 1. Stage 2 outcome

At the end of Stage 2, we have:

- the same MCP endpoint shape and the same canonical Tool API contracts
- Okta-backed OAuth authentication for the human user
- principal-aware authorization decisions inside the Tool API
- source visibility and query execution constrained by the human user’s Okta-derived entitlements
- audit events that identify the real human principal
- a migration path off Stage 1 personal tokens

---

## 2. What changes from Stage 1

## What stays the same
- MCP remains a thin adapter
- Tool API remains the canonical contract
- connectors remain behind the same application layer
- the product remains read-only
- Cursor and Claude Code remain the only supported clients unless scope expands

## What changes
- principal comes from verified Okta-backed OAuth, not a personal token
- authorization decisions become principal-aware
- audit becomes identity-accurate
- source discovery and query execution can vary by user

---

## 3. Stage 2 guiding design

### 3.1 Keep identity in the core, not the edge
The MCP layer may participate in auth handshakes, but the **meaning** of identity and access lives in the Tool API / policy layer.

### 3.2 Preserve the tool contracts
Do not redesign tools just because auth changes. The inputs and outputs for `list_sources`, `describe_relation`, and `execute_readonly_sql` should stay stable.

### 3.3 Start with simple policy mapping
Do not build a giant policy platform in Stage 2 v1.

Start with:
- source-level access
- optional namespace-level allowlists if required immediately
- mapping from Okta claims / groups to named access profiles

### 3.4 Use the warehouse as a second line of defense, not the first line
Primary decision point is the Tool API. Connectors should still use least-privilege execution profiles.

### 3.5 Migrate, do not big-bang
Run Stage 1 token auth and Stage 2 OAuth in parallel for a controlled migration window, then remove token auth.

---

## 4. Authorization model

## Principal model
A `Principal` is derived from a verified Okta-backed token and includes at minimum:

- `subject`
- `email` or display name if available
- `issuer`
- `audience`
- `groups` and/or custom access claims
- token issue / expiry metadata

## Access profile model
Do not encode every rule directly in code branches. Map Okta identity signals to named access profiles such as:

- `source:snowflake:read`
- `source:athena:read`
- `source:motherduck:read`
- optionally `namespace:snowflake:ANALYTICS.CORE:read`

The policy engine consumes access profiles and makes tool decisions.

## Decision points
For each invocation, answer these in order:

1. Is the caller authenticated?
2. Is the caller allowed to use this tool?
3. Is the caller allowed to use this source?
4. If a namespace or relation is referenced, is that target allowed?
5. Is the SQL request read-only and within limits?
6. Which connector execution profile should be used?

---

## 5. Delivery shape

Remain a modular monolith unless strong evidence says otherwise.

Add modules such as:

```text
/src
  /domain
    /identity
    /policy
  /application
  /adapters
    /mcp
    /auth
  /infrastructure
    /okta
    /jwks
    /audit
```

### New components introduced logically
- Okta token validation
- policy resolution
- access profile mapping
- migration support for dual auth modes

### New components *not* required yet
- standalone policy service
- standalone token exchange service
- separate identity microservice
- admin UI-heavy entitlement management

---

## 6. Release slices

## Stage 2 v1 — minimum identity upgrade
- Okta OAuth integrated for human users
- validated principal available inside Tool API
- source-level authorization based on Okta claims / groups
- `list_sources` filtered by principal
- metadata and query tools enforce source access
- audit records true human principal
- dual auth mode available during migration

## Stage 2 v2 — maturity and hardening
- namespace-level or profile-level refinement if needed
- improved revocation responsiveness
- better policy diagnostics
- PAT removal
- stronger admin visibility and drift detection

---

## 7. Stage 2 exit criteria

The stage is complete when all of the following are true:

1. A pilot user can authenticate from Cursor and Claude Code using Okta-backed OAuth.
2. `list_sources` only returns sources allowed for that user.
3. A user denied access to a source cannot list metadata or run queries against it.
4. Audit logs show the real human principal and policy decision.
5. Stage 1 token auth can be disabled without changing tool contracts.
6. The system handles expired tokens, wrong audiences, missing claims, and policy denials deterministically.

---

## 8. Milestone order

### M0 — identity design
- principal model
- claim / group strategy
- Okta app setup prerequisites
- migration strategy

### M1 — auth integration
- token validation
- metadata / discovery compatibility
- 401 and 403 behavior
- staged compatibility tests

### M2 — policy enforcement
- access profile mapping
- source filtering
- policy-aware tool execution
- audit enrichment

### M3 — client onboarding and migration
- Cursor and Claude Code login/runbooks
- dual auth rollout
- pilot users moved to OAuth

### M4 — Stage 2 v2 hardening
- finer-grained policy if needed
- revocation / drift improvements
- PAT removal
- better diagnostics and reports

---

## 9. Epics, tasks, acceptance criteria, and tests

## Epic S2-E1 — Identity domain model and Okta prerequisites

### S2-E1-T1 — Define the principal model
**Deliverable**
- `Principal` value object / aggregate
- `PrincipalClaims`
- `AccessProfile`
- `PolicyDecision`

**Acceptance criteria**
- principal is explicit in the application layer
- no tool accepts caller identity from untrusted request payload alone
- principal shape works for both Stage 1 token and Stage 2 OAuth during migration

**Tests**
- unit tests for principal construction
- backward-compatibility tests for dual-auth principal resolution

### S2-E1-T2 — Define Okta claim mapping strategy
**Deliverable**
- documented mapping from Okta groups / claims to access profiles
- decision on which claim is the source of truth

**Acceptance criteria**
- mapping is simple enough to reason about
- mapping can be updated without changing tool contracts
- security partner signs off the model

**Tests**
- fixture-based claim mapping tests
- negative tests for missing or malformed claims

### S2-E1-T3 — Prepare Okta app integration inputs
**Deliverable**
- issuer
- audience
- scopes / claims expected
- redirect / metadata assumptions
- staging and production app details

**Acceptance criteria**
- environments are documented separately
- no hardcoded tenant assumptions in code
- implementation team has all inputs required to validate tokens

**Tests**
- config validation tests
- staging/prod config separation tests

---

## Epic S2-E2 — OAuth / MCP compatibility and token validation

### S2-E2-T1 — Implement token validation
**Deliverable**
- signature validation
- issuer validation
- audience validation
- expiry / not-before checks
- JWKS retrieval and caching

**Acceptance criteria**
- invalid tokens never reach application services
- cache behavior is safe and observable
- clock skew handling is explicit

**Tests**
- valid token acceptance
- expired token rejection
- wrong issuer rejection
- wrong audience rejection
- key rotation / JWKS refresh tests

### S2-E2-T2 — Implement auth discovery / compatibility behavior
**Deliverable**
- MCP-compatible auth behavior for remote HTTP access
- metadata or discovery endpoints needed for target clients
- proper `401 Unauthorized` and `403 Forbidden` semantics

**Acceptance criteria**
- Cursor and Claude Code can discover and complete auth against staging
- the server does not rely on undocumented manual hacks
- auth failures are actionable

**Tests**
- compatibility tests with a headless MCP client
- manual login smoke tests in both target clients
- 401 / 403 behavior tests

### S2-E2-T3 — Support public-client-safe flow assumptions
**Deliverable**
- PKCE-friendly compatibility
- secure token storage assumptions delegated to client
- server-side validation only

**Acceptance criteria**
- design works with local/public MCP clients
- no server-side dependence on client secrets for local tools

**Tests**
- integration tests for expected redirect / callback pattern where testable
- documentation review against client behavior

### S2-E2-T4 — Dual auth mode
**Deliverable**
- support both Stage 1 named tokens and Stage 2 OAuth for migration window
- principal resolution path for each mode

**Acceptance criteria**
- audit clearly distinguishes auth mode used
- disabling token mode later is a config change, not a rewrite

**Tests**
- regression tests for both auth modes
- mixed-mode audit tests

---

## Epic S2-E3 — Policy engine inside the Tool API

### S2-E3-T1 — Implement policy decision point
**Deliverable**
- `PolicyEngine` or equivalent application service
- source access checks
- optional namespace access checks

**Acceptance criteria**
- no connector enforces primary user policy on its own
- all tool invocations pass through a central decision point
- denials produce explicit reasons

**Tests**
- unit tests for allow and deny decisions
- policy regression test matrix

### S2-E3-T2 — Filter `list_sources` by principal
**Deliverable**
- `list_sources` only returns permitted sources

**Acceptance criteria**
- users never see sources they cannot query
- the response remains contract-compatible

**Tests**
- positive tests per allowed source
- negative tests for denied sources

### S2-E3-T3 — Enforce policy on metadata tools
**Deliverable**
- `list_namespaces`, `list_relations`, `describe_relation` respect user access

**Acceptance criteria**
- denied sources return safe errors or empty filtered results as defined
- behavior is consistent across metadata tools

**Tests**
- source-denied tests
- namespace-denied tests if namespace policy is in v1

### S2-E3-T4 — Enforce policy on query execution
**Deliverable**
- `execute_readonly_sql` requires:
  - authenticated principal
  - allowed source
  - allowed namespace if applicable
  - valid read-only SQL

**Acceptance criteria**
- unauthorized query attempts never hit the connector
- denied attempts are audited with reason

**Tests**
- policy-denied query tests
- connector-not-invoked assertion tests
- read-only plus auth combined tests

---

## Epic S2-E4 — Principal propagation and audit enrichment

### S2-E4-T1 — Propagate principal context through the call chain
**Deliverable**
- principal carried from auth layer to Tool API to connectors to audit

**Acceptance criteria**
- no layer needs to re-derive identity from raw headers
- principal fields are available for audit and query tagging

**Tests**
- propagation tests across layers
- no-header-trust tests

### S2-E4-T2 — Enrich audit schema
**Deliverable**
Additional audit fields:
- auth mode
- token subject
- claims snapshot reference or summarized access profiles
- deny reason
- policy version

**Acceptance criteria**
- audit answers “who was the human and why was access allowed or denied?”
- schema remains backward-compatible for existing queries/reports where possible

**Tests**
- schema evolution tests
- report regression tests

### S2-E4-T3 — Add principal-aware query tagging
**Deliverable**
- include principal identifiers in source tags/comments where safe

**Acceptance criteria**
- source-side investigation can correlate back to the human principal
- sensitive claims are not over-shared downstream

**Tests**
- integration tests for available source-side tags
- serialization / redaction tests

---

## Epic S2-E5 — Client onboarding and user experience

### S2-E5-T1 — Cursor Okta onboarding flow
**Deliverable**
- documented Cursor setup for the remote MCP server
- documented OAuth login behavior
- error recovery steps

**Acceptance criteria**
- a pilot user can set this up with the runbook
- support burden is reasonable

**Tests**
- manual smoke tests
- onboarding dry-run with non-implementer

### S2-E5-T2 — Claude Code Okta onboarding flow
**Deliverable**
- documented Claude Code setup
- documented `/mcp` authentication flow
- error recovery steps

**Acceptance criteria**
- a pilot user can authenticate and use tools without bespoke engineering help

**Tests**
- manual smoke tests
- onboarding dry-run with non-implementer

### S2-E5-T3 — Error messaging and supportability
**Deliverable**
- user-facing error guidance for:
  - auth required
  - session expired
  - access denied
  - missing entitlement

**Acceptance criteria**
- user can distinguish “login problem” from “permission problem”
- support can triage without reading server code

**Tests**
- error catalog tests
- documentation walkthroughs

---

## Epic S2-E6 — Migration and cutover

### S2-E6-T1 — Instrument migration dashboards
**Deliverable**
- adoption metrics:
  - token auth vs OAuth auth
  - successful logins
  - denied attempts
  - active users by auth mode

**Acceptance criteria**
- rollout can be managed with evidence, not anecdotes

**Tests**
- metrics correctness tests
- fixture-based dashboard query tests

### S2-E6-T2 — Pilot migration
**Deliverable**
- migrate pilot users from token auth to OAuth
- feedback log
- issues triaged into backlog

**Acceptance criteria**
- pilot users complete normal work with OAuth
- no tool contract changes required

**Tests**
- pilot checklist completion
- post-migration smoke tests

### S2-E6-T3 — Token auth deprecation plan
**Deliverable**
- removal plan
- communication steps
- config flag / feature flag for disablement

**Acceptance criteria**
- token auth removal is predictable and reversible during rollout
- all production usage is observable by auth mode

**Tests**
- feature flag tests
- rollback tests

---

## Epic S2-E7 — Stage 2 v2 hardening

### S2-E7-T1 — Namespace-level policy refinement
**Deliverable**
- optional namespace / relation restrictions if needed by stakeholders

**Acceptance criteria**
- finer-grained policy can be added without changing tool shapes
- implementation remains understandable

**Tests**
- namespace allow/deny matrix tests
- regression tests for source-level rules

### S2-E7-T2 — Revocation and drift responsiveness
**Deliverable**
- documented TTLs / cache invalidation for policy and keys
- operator guidance for urgent entitlement changes

**Acceptance criteria**
- access changes propagate within an agreed operational window
- there is a manual emergency path if needed

**Tests**
- cache expiry tests
- entitlement change propagation tests
- key rotation tests

### S2-E7-T3 — Policy diagnostics
**Deliverable**
- clearer deny reasons
- operator report or lightweight admin diagnostics
- policy version in audit

**Acceptance criteria**
- support can explain denials quickly
- security can verify effective access behavior

**Tests**
- deny reason report tests
- audit diagnostic tests

### S2-E7-T4 — Remove Stage 1 tokens
**Deliverable**
- token auth disabled in production
- docs and onboarding updated

**Acceptance criteria**
- all supported users are on OAuth
- no hidden operational dependency on personal tokens remains

**Tests**
- auth mode removal regression tests
- smoke tests in both target clients

---

## 10. Test strategy

## Test layers

### Unit tests
Use for:
- principal resolution
- claim mapping
- policy decision rules
- deny reason generation
- token/JWKS validation helpers

### Contract tests
Use for:
- unchanged tool contracts from Stage 1
- audit schema evolution
- auth error envelope shape

### Integration tests
Use for:
- Okta token validation against staging metadata/JWKS assumptions
- connector access selection
- source filtering by principal
- audit enrichment

### End-to-end tests
Use for:
- OAuth-authenticated MCP call -> Tool API -> policy -> connector -> audit
- denied access path -> no connector call -> audit
- expired session -> 401 -> re-auth path behavior

### Manual smoke tests
Use for:
- Cursor login and tool usage
- Claude Code login and tool usage
- token expiration / reauthentication UX
- migration from Stage 1 token setup

## Must-pass Stage 2 test catalog

### S2-TEST-001
Valid Okta-authenticated user can log in and call `list_sources`.

### S2-TEST-002
Expired token returns `AUTH_REQUIRED` or equivalent re-auth signal.

### S2-TEST-003
Wrong audience token is rejected.

### S2-TEST-004
User with Snowflake-only entitlement cannot see Athena or MotherDuck.

### S2-TEST-005
Denied user cannot call `metadata.describe_relation` on a blocked source.

### S2-TEST-006
Denied query attempt never reaches connector execution.

### S2-TEST-007
Audit record contains principal identity and policy decision.

### S2-TEST-008
Cursor OAuth flow works against staging.

### S2-TEST-009
Claude Code OAuth flow works against staging.

### S2-TEST-010
Dual auth mode produces correct principal attribution for both token and OAuth users.

### S2-TEST-011
Key rotation or JWKS refresh does not break valid sessions unexpectedly.

### S2-TEST-012
Removing a user’s entitlement causes access denial within the documented propagation window.

---

## 11. Definition of done for Stage 2 tasks

A Stage 2 task is not done until:

- implementation is complete
- tests exist at the correct layer
- audit fields are added if behavior changed
- docs and onboarding steps are updated
- security partner has reviewed any auth or policy change
- the change preserves Stage 1 tool contracts unless an explicit exception is approved

---

## 12. Recommended policy implementation approach

## Stage 2 v1
Keep policy simple and explicit.

**Recommended shape**
- map Okta groups or custom claims to named access profiles
- allow profiles primarily at source level
- filter source discovery
- deny disallowed source invocations centrally

**Why**
- easy to explain
- easy to audit
- low refactor risk
- enough for the stage goal

## Stage 2 v2
Add namespace-level refinement only if stakeholder need is real.

**Do not start with**
- generic ABAC engine
- external policy language unless the team already operates one well
- dynamic per-table rules everywhere

---

## 13. Risks and mitigations

### Risk: Okta claim model is too complex or unstable
**Mitigation:** choose one primary claim/group strategy and keep a translation layer in our code.

### Risk: client compatibility with OAuth flows is messier than expected
**Mitigation:** validate real Cursor and Claude Code behavior in staging early; keep a compatibility harness and document workarounds only after testing.

### Risk: Stage 1 token behavior leaks into core business logic
**Mitigation:** resolve both token and OAuth into the same `Principal` model and keep auth-mode-specific logic at the edge.

### Risk: authorization becomes scattered across connectors
**Mitigation:** make the Tool API the only policy decision point and assert in tests that denied requests never invoke connectors.

### Risk: revocation expectations become unrealistic
**Mitigation:** document propagation window in v1 and improve it in v2 rather than hand-waving “instant” behavior.

---

## 14. Handoff checklist before implementation starts

Confirm these inputs before coding begins:

- Okta issuer and audience values for staging and production
- chosen claim/group source of truth
- pilot users and expected access matrix
- required redirect / discovery assumptions for target clients
- security sign-off on claim-to-access-profile mapping
- decision on whether source-level access is sufficient for Stage 2 v1

---

## 15. Reference assumptions from current official docs

- MCP’s authorization guidance for HTTP transports is OAuth 2.1-oriented, with authorization code as the example for human end users, PKCE required for clients, and explicit 401/403 semantics.  
  <https://modelcontextprotocol.io/specification/2025-03-26/basic/authorization>

- Okta’s MCP guidance emphasizes least privilege, auditability, and interactive vs browserless auth modes.  
  <https://developer.okta.com/docs/concepts/mcp-server/>

- Claude Code supports OAuth authentication for remote MCP servers via its MCP flow.  
  <https://docs.anthropic.com/en/docs/claude-code/mcp>

- Cursor supports OAuth for remote MCP servers.  
  <https://docs.cursor.com/en/context/mcp>
