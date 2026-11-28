# MCP data access — the golden path

How agents and operators run **read-only SQL against approved sources**
through `service/mcp`: connect → check readiness → discover → describe →
query → audit. This is the operator companion to `docs/mcp-onboarding.md`
(which covers connecting a harness; this document covers the data tools).

The path is credential-free locally: each source defaults to **mock mode**
with deterministic answers, so the whole flow works end to end before any
warehouse access is wired.

## Approved sources

| Source | Tools | Local/demo default | Real mode status |
|---|---|---|---|
| `snowflake` | `data.query`, `data.list_tables`, `data.describe_table` | mock | query path live; catalog metadata (list/describe) returns empty until metadata parity lands |
| `athena` | same | mock | query path live; catalog metadata returns empty until metadata parity lands; AWS credentials/region from the standard AWS chain |
| `motherduck` | same | mock | query and catalog paths live (DuckDB driver); requires `MOTHERDUCK_TOKEN` |

## 1. Check readiness

`GET /v1/data-sources` (bearer auth, like every `/v1` route) reports each
source's mode and whether it can serve right now. It reports configuration
**presence only — never values**:

```bash
curl -s localhost:3000/v1/data-sources -H "Authorization: Bearer $TOK" | jq
```

```json
{
  "data_sources": [
    { "data_source": "snowflake", "mode": "mock", "ready": true },
    { "data_source": "athena", "mode": "mock", "ready": true },
    { "data_source": "motherduck", "mode": "mock", "ready": true }
  ]
}
```

A real-mode source that is missing configuration lists the env var *names*
under `missing_config` (e.g. `ATHENA_WORKGROUP`) and stays `ready: false`.

## 2. The golden path

The same three steps per source: **list → describe → query**. The mock
answers below are exactly what the local demo returns, so you can verify
your client wiring before switching to real mode.

```bash
API=http://localhost:3000
TOK=<mcp bearer token>

# Discover tables (data.list_tables)
curl -s -X POST "$API/v1/tools/data.list_tables:execute" \
  -H "Authorization: Bearer $TOK" -H 'content-type: application/json' \
  -H 'x-agent-client: shell' \
  -d '{"data_source": "snowflake"}' | jq '.result'
# -> { "tables": [{ "database": "DB", "schema": "PUBLIC", "name": "EXAMPLE_TABLE", "type": "TABLE" }], "truncated": false }

# Describe a table (data.describe_table)
curl -s -X POST "$API/v1/tools/data.describe_table:execute" \
  -H "Authorization: Bearer $TOK" -H 'content-type: application/json' \
  -d '{"data_source": "snowflake", "database": "DB", "schema": "PUBLIC", "table": "EXAMPLE_TABLE"}' \
  | jq '.result'
# -> columns: id VARCHAR NOT NULL, created_at TIMESTAMP NULL

# Run a read-only query (data.query)
curl -s -X POST "$API/v1/tools/data.query:execute" \
  -H "Authorization: Bearer $TOK" -H 'content-type: application/json' \
  -d '{"data_source": "snowflake", "sql": "select 1 as one"}' | jq '.result'
# -> { "columns": …, "rows": [{ "one": 1 }], "row_count_returned": 1,
#      "truncated": false, "warehouse_execution_id": "snowflake-mock-query-id" }
```

Per-source mock tables: `snowflake` → `DB.PUBLIC.EXAMPLE_TABLE`,
`athena` → `db.default.ATHENA_TABLE`, `motherduck` → `md.main.MOTHERDUCK_TABLE`.
The `data_source` field selects the connector; the same call sequence works
against every source and over both surfaces (the REST Tool API above and the
MCP tools with identical names/arguments).

## 3. Real mode setup

Real mode is per source and environment-driven; a source in `real` mode is
still guarded by the same policy, read-only validation, limits, and audit as
mock.

**Snowflake** (`SNOWFLAKE_MODE=real`): required `SNOWFLAKE_ACCOUNT`,
`SNOWFLAKE_USERNAME`, `SNOWFLAKE_PASSWORD`; optional `SNOWFLAKE_WAREHOUSE`,
`SNOWFLAKE_DATABASE`, `SNOWFLAKE_SCHEMA`, `SNOWFLAKE_ROLE`. Queries set a
server-side `STATEMENT_TIMEOUT_IN_SECONDS` from the caller's timeout and
destroy the session on timeout, so abandoned queries stop burning credits.

**Athena** (`ATHENA_MODE=real`): required `ATHENA_WORKGROUP`,
`ATHENA_OUTPUT_S3`; credentials and region come from the standard AWS
environment chain (`AWS_REGION`, `AWS_ACCESS_KEY_ID`/`AWS_PROFILE`, instance
role, …). Timed-out queries are actively stopped (`StopQueryExecution`).

**MotherDuck** (`MOTHERDUCK_MODE=real`): required `MOTHERDUCK_TOKEN`
(the token is passed to the DuckDB driver config explicitly; never logged);
optional `MOTHERDUCK_DATABASE` (defaults to `my_db`). Queries and catalog
metadata (`data.list_tables` via `information_schema.tables`,
`data.describe_table` via `DESCRIBE`) run through the shared DuckDB instance
cache, with a bounded 30s connect sequence and statement timeouts enforced
by interrupting the running query.

## 4. What governs every call

- **Read-only SQL**: a single statement starting with `SELECT` or `WITH`;
  write/DDL keywords (`INSERT`, `UPDATE`, `DELETE`, `MERGE`, `CREATE`,
  `ALTER`, `DROP`, `TRUNCATE`, `GRANT`, `REVOKE`, `COPY`, `UNLOAD`, `CALL`,
  `PUT`, `GET`, `USE`, `SET`) are rejected before any connector sees the SQL.
- **Entitlements** (`AUTHZ_RULES_JSON`, optional): per-group allowlists
  (`allow.tools`, `allow.data_sources.<source>.{databases,schemas,tables}`
  glob patterns). When configured, every principal type is checked and
  unmatched requests fail closed (`no_matching_entitlement`,
  `source_not_allowed`, `table_not_allowed`, …). `data.query` statements have
  their referenced objects extracted and checked against the same allowlists,
  denying `unparseable_object_refs` when objects cannot be identified.
- **Limits**: `max_rows` defaults to 50 (hard max 500), `timeout_ms` to
  15s (hard max 60s), output to 65,536 bytes — rows are dropped and
  `truncated: true` is set when a cap is hit. Requested values are clamped,
  never trusted.
- **Audit**: every tool call (allow, deny, and connector failure) is audited
  with principal, tool, data source, limits applied, latency, rows returned,
  truncation, execution id, and safe error. Auth failures are audited too.

## 5. Demo prompts

Paste any of these into a connected harness (Claude Code, Cursor, opencode —
see `docs/mcp-onboarding.md` § 3). Each expects the same
readiness → list → describe → query sequence:

> **Snowflake:** "Check `data-sources` readiness, then use `data.list_tables`
> on snowflake, `data.describe_table` for `DB.PUBLIC.EXAMPLE_TABLE`, and run
> `select 1 as one` with `data.query`. Summarize what the governed path
> returned and the execution id."

> **Athena:** "Run the golden path against athena: list tables, describe
> `db.default.ATHENA_TABLE`, then `data.query` with `select 1 as one`. Show
> the columns and how truncation is reported."

> **MotherDuck:** "List tables on motherduck, describe
> `md.main.MOTHERDUCK_TABLE`, and query `select 1 as one`. Note the mode the
> readiness check reports."

An agent prompt that exercises governance rather than data:

> "Try `data.query` with `drop table users` against snowflake and explain,
> from the response, which layer refused it and what the audit recorded."

## 6. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `401` on any call | Missing/incorrect bearer token; create one with `npm run create-api-key` (service/mcp). |
| `ready: false` with `missing_config` | Real mode selected but env vars absent — set them or switch back to `mock`. |
| `not_read_only` / `forbidden_keyword` / `multiple_statements` | The SQL is not a single read-only statement; rewrite it. |
| `source_not_allowed` / `table_not_allowed` | `AUTHZ_RULES_JSON` is configured and the principal's group lacks this source/object; extend the rule. |
| Real Snowflake/Athena `list_tables`/`describe_table` return empty | Expected today: catalog metadata parity is not yet implemented for real mode; queries still work. |
| `MotherDuck is not configured` | Real mode without `MOTHERDUCK_TOKEN` — set it or switch back to `mock`. |
| MotherDuck `request failed` | Token rejected or the `md:` database is unreachable; check `MOTHERDUCK_TOKEN`/`MOTHERDUCK_DATABASE` and connectivity. |

## Related

- `docs/mcp-onboarding.md` — connecting a harness (auth, configs, resources)
- `service/mcp/README.md` — operator guide and local setup
- `service/mcp/AGENTS/` — the data-access gateway product/architecture specs
