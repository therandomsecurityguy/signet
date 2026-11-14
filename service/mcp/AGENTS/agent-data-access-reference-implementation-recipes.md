# Agent Data Access Gateway — Reference Implementation Recipes

> These snippets are implementation scaffolding for the dev team. They are intentionally concise and should be adapted to the repo’s actual package versions and coding conventions.

---

# 1. Package baseline

```json
{
  "dependencies": {
    "@hono/node-server": "latest",
    "@modelcontextprotocol/sdk": "latest",
    "@okta/jwt-verifier": "latest",
    "@opentelemetry/api": "latest",
    "@opentelemetry/auto-instrumentations-node": "latest",
    "@opentelemetry/exporter-trace-otlp-http": "latest",
    "@opentelemetry/resources": "latest",
    "@opentelemetry/sdk-node": "latest",
    "@opentelemetry/semantic-conventions": "latest",
    "@aws-sdk/client-athena": "latest",
    "@duckdb/node-api": "latest",
    "@hono/zod-validator": "latest",
    "hono": ">=4.10.2",
    "pino": "latest",
    "snowflake-sdk": "latest",
    "zod": "^4"
  }
}
```

References:
- Hono: https://hono.dev/
- MCP SDK: https://github.com/modelcontextprotocol/typescript-sdk
- Zod 4: https://zod.dev/
- OpenTelemetry JS: https://opentelemetry.io/docs/languages/js/
- Okta JWT verifier: https://github.com/okta/okta-jwt-verifier-js

---

# 2. OpenTelemetry bootstrap (`src/infrastructure/telemetry/instrumentation.ts`)

Start OTel **before** the app imports the rest of the code. OpenTelemetry’s Node docs emphasize early initialization.

```ts
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';

const traceExporter = new OTLPTraceExporter();

export const otelSdk = new NodeSDK({
  traceExporter,
  instrumentations: [getNodeAutoInstrumentations()],
});

otelSdk.start();
```

Run with Node 20+ using early import:
```bash
node --import ./dist/infrastructure/telemetry/instrumentation.js ./dist/app/server.js
```

References:
- https://opentelemetry.io/docs/languages/js/getting-started/nodejs/
- https://opentelemetry.io/docs/zero-code/js/

---

# 3. Pino logger (`src/infrastructure/logging/pino.ts`)

```ts
import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: [
      'req.headers.authorization',
      'authorization',
      'headers.authorization',
      'cookie',
      'set-cookie',
      '*.token',
      '*.access_token',
      '*.refresh_token'
    ],
    censor: '[REDACTED]'
  },
  base: {
    service: 'agent-data-access-gateway'
  }
});
```

Create request-scoped child loggers with curated fields only:

```ts
import { trace } from '@opentelemetry/api';
import type { Logger } from 'pino';

export function makeRequestLogger(base: Logger, input: {
  requestId: string;
  principalId?: string;
  clientName?: string;
}) {
  const span = trace.getActiveSpan();
  const spanCtx = span?.spanContext();

  return base.child({
    request_id: input.requestId,
    principal_id: input.principalId,
    client_name: input.clientName,
    trace_id: spanCtx?.traceId,
    span_id: spanCtx?.spanId,
  });
}
```

References:
- https://github.com/pinojs/pino
- https://github.com/pinojs/pino/blob/main/docs/redaction.md
- https://github.com/pinojs/pino/blob/main/docs/child-loggers.md

---

# 4. Hono bootstrap (`src/app/server.ts`)

```ts
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { requestId } from 'hono/request-id';
import { logger as baseLogger } from '../infrastructure/logging/pino.js';
import { makeRequestLogger } from '../infrastructure/logging/request-logger.js';

type AppEnv = {
  Variables: {
    requestId: string;
    principal?: {
      type: 'api_key' | 'okta_user';
      id: string;
      scopes?: string[];
      groups?: string[];
      claims?: Record<string, unknown>;
    };
    logger: ReturnType<typeof makeRequestLogger>;
  };
};

const app = new Hono<AppEnv>();

app.use('*', requestId());

app.use('*', async (c, next) => {
  const requestId = c.get('requestId');
  const clientName = c.req.header('X-Agent-Client') ?? 'unknown';
  const logger = makeRequestLogger(baseLogger, { requestId, clientName });
  c.set('logger', logger);
  await next();
});

app.get('/healthz', (c) => c.json({ ok: true }));
app.get('/readyz', (c) => c.json({ ok: true }));

serve({
  fetch: app.fetch,
  port: Number(process.env.PORT ?? 3000),
});
```

References:
- Hono Node: https://hono.dev/docs/getting-started/nodejs
- Hono request ID: https://hono.dev/docs/middleware/builtin/request-id

---

# 5. Zod contracts (`src/contracts/tools/data-query.ts`)

```ts
import { z } from 'zod';

export const DataSourceSchema = z.enum(['snowflake', 'athena', 'motherduck']);

export const DataQueryInputSchema = z.object({
  data_source: DataSourceSchema,
  sql: z.string().min(1).max(50_000),
  max_rows: z.number().int().positive().max(500).optional(),
  timeout_ms: z.number().int().positive().max(60_000).optional(),
});

export const DataQueryOutputSchema = z.object({
  columns: z.array(z.object({
    name: z.string(),
    type: z.string().optional(),
  })),
  rows: z.array(z.record(z.string(), z.unknown())),
  row_count_returned: z.number().int().nonnegative(),
  truncated: z.boolean(),
  warehouse_execution_id: z.string().optional(),
  stats: z.record(z.string(), z.unknown()).optional(),
});

export type DataQueryInput = z.infer<typeof DataQueryInputSchema>;
export type DataQueryOutput = z.infer<typeof DataQueryOutputSchema>;
```

For Hono route validation:

```ts
import { zValidator } from '@hono/zod-validator';

app.post(
  '/v1/tools/data.query:execute',
  zValidator('json', DataQueryInputSchema),
  async (c) => {
    const input = c.req.valid('json');
    // delegate to use case
    return c.json({ ok: true, input });
  }
);
```

References:
- Zod 4: https://zod.dev/
- Hono RPC / validation examples: https://hono.dev/docs/guides/rpc

---

# 6. Canonical tool registry (`src/domain/tools/tool-registry.ts`)

```ts
import type { ZodTypeAny } from 'zod';
import {
  DataQueryInputSchema,
  DataQueryOutputSchema,
} from '../../contracts/tools/data-query.js';

export type ToolDefinition = {
  name: 'data.query' | 'data.list_tables' | 'data.describe_table';
  version: string;
  description: string;
  riskTier: 'READ_ONLY';
  inputSchema: ZodTypeAny;
  outputSchema: ZodTypeAny;
};

export const toolRegistry: ToolDefinition[] = [
  {
    name: 'data.query',
    version: '1.0.0',
    description: 'Run a read-only SQL query against an approved data source.',
    riskTier: 'READ_ONLY',
    inputSchema: DataQueryInputSchema,
    outputSchema: DataQueryOutputSchema,
  },
  // add data.list_tables and data.describe_table
];

export function getToolDefinition(name: string): ToolDefinition | undefined {
  return toolRegistry.find((t) => t.name === name);
}
```

---

# 7. Application use case (`src/application/usecases/execute-tool.ts`)

```ts
type ExecuteToolRequest = {
  toolName: string;
  principal: {
    type: 'api_key' | 'okta_user';
    id: string;
    scopes?: string[];
    groups?: string[];
    claims?: Record<string, unknown>;
  };
  rawInput: unknown;
  requestContext: {
    requestId: string;
    clientName?: string;
  };
};

type Ports = {
  policyService: {
    evaluate(req: {
      principal: ExecuteToolRequest['principal'];
      toolName: string;
      parsedInput: unknown;
    }): Promise<{
      effect: 'allow' | 'deny';
      reason: string;
      limits: {
        maxRows: number;
        timeoutMs: number;
        maxOutputBytes: number;
      };
    }>;
  };
  toolExecutor: {
    execute(toolName: string, parsedInput: unknown, limits: {
      maxRows: number;
      timeoutMs: number;
      maxOutputBytes: number;
    }): Promise<unknown>;
  };
  auditPublisher: {
    publish(event: Record<string, unknown>): Promise<void>;
  };
  registry: {
    get(name: string): { inputSchema: { parse: (v: unknown) => unknown } } | undefined;
  };
};

export class ExecuteToolUseCase {
  constructor(private readonly ports: Ports) {}

  async execute(req: ExecuteToolRequest) {
    const def = this.ports.registry.get(req.toolName);
    if (!def) {
      throw new Error('TOOL_NOT_FOUND');
    }

    const parsedInput = def.inputSchema.parse(req.rawInput);

    const decision = await this.ports.policyService.evaluate({
      principal: req.principal,
      toolName: req.toolName,
      parsedInput,
    });

    if (decision.effect === 'deny') {
      await this.ports.auditPublisher.publish({
        request_id: req.requestContext.requestId,
        principal_id: req.principal.id,
        tool_name: req.toolName,
        policy_effect: 'deny',
        policy_reason: decision.reason,
      });

      return {
        decision,
        result: null,
        error: {
          code: 'AUTH_FORBIDDEN',
          message: 'Access denied for this tool request.',
        },
      };
    }

    const result = await this.ports.toolExecutor.execute(
      req.toolName,
      parsedInput,
      decision.limits,
    );

    await this.ports.auditPublisher.publish({
      request_id: req.requestContext.requestId,
      principal_id: req.principal.id,
      tool_name: req.toolName,
      policy_effect: 'allow',
      policy_reason: decision.reason,
    });

    return {
      decision,
      result,
      error: null,
    };
  }
}
```

---

# 8. Stage 1 API key middleware (`src/app/middleware/auth-api-key.ts`)

```ts
import type { MiddlewareHandler } from 'hono';

type ApiKeyLookup = {
  findByToken(token: string): Promise<null | {
    keyId: string;
    ownerLabel: string;
  }>;
};

export function apiKeyAuth(apiKeys: ApiKeyLookup): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header('Authorization');
    const logger = c.get('logger');

    if (!header?.startsWith('Bearer ')) {
      logger.warn({ auth: 'missing_bearer' }, 'authentication failed');
      return c.json({ error: 'unauthorized' }, 401);
    }

    const token = header.slice('Bearer '.length);
    const record = await apiKeys.findByToken(token);

    if (!record) {
      logger.warn({ auth: 'invalid_bearer' }, 'authentication failed');
      return c.json({ error: 'unauthorized' }, 401);
    }

    c.set('principal', {
      type: 'api_key',
      id: record.keyId,
      claims: {},
      scopes: [],
      groups: [],
    });

    await next();
  };
}
```

---

# 9. Stage 2 Okta middleware (`src/app/middleware/auth-okta.ts`)

```ts
import OktaJwtVerifier from '@okta/jwt-verifier';
import type { MiddlewareHandler } from 'hono';

const oktaJwtVerifier = new OktaJwtVerifier({
  issuer: process.env.OKTA_ISSUER!,
});

export function oktaAuth(expectedAudience: string): MiddlewareHandler {
  return async (c, next) => {
    const auth = c.req.header('Authorization');
    const logger = c.get('logger');

    if (!auth?.startsWith('Bearer ')) {
      return c.json({ error: 'unauthorized' }, 401);
    }

    const accessToken = auth.slice('Bearer '.length);

    try {
      const jwt = await oktaJwtVerifier.verifyAccessToken(accessToken, expectedAudience);

      c.set('principal', {
        type: 'okta_user',
        id: jwt.claims.sub as string,
        email: jwt.claims.email as string | undefined,
        scopes: Array.isArray(jwt.claims.scp) ? jwt.claims.scp as string[] : [],
        groups: Array.isArray(jwt.claims.groups) ? jwt.claims.groups as string[] : [],
        claims: jwt.claims,
      });

      await next();
    } catch (err) {
      logger.warn({ err }, 'okta token validation failed');
      return c.json({ error: 'unauthorized' }, 401);
    }
  };
}
```

References:
- https://developer.okta.com/docs/guides/validate-access-tokens/nodejs/main/
- https://github.com/okta/okta-jwt-verifier-js

---

# 10. Snowflake connector recipe (`src/infrastructure/connectors/snowflake/connector.ts`)

```ts
import snowflake from 'snowflake-sdk';

export function createSnowflakeConnection() {
  return snowflake.createConnection({
    account: process.env.SNOWFLAKE_ACCOUNT,
    username: process.env.SNOWFLAKE_USERNAME,
    password: process.env.SNOWFLAKE_PASSWORD,
    warehouse: process.env.SNOWFLAKE_WAREHOUSE,
    database: process.env.SNOWFLAKE_DATABASE,
    schema: process.env.SNOWFLAKE_SCHEMA,
    role: process.env.SNOWFLAKE_ROLE,
  });
}

export async function executeSnowflakeQuery(sqlText: string): Promise<{
  rows: Record<string, unknown>[];
  warehouse_execution_id?: string;
}> {
  const connection = createSnowflakeConnection();

  await new Promise<void>((resolve, reject) => {
    connection.connect((err) => (err ? reject(err) : resolve()));
  });

  return await new Promise((resolve, reject) => {
    connection.execute({
      sqlText,
      asyncExec: false,
      complete(err, stmt, rows) {
        if (err) return reject(err);
        resolve({
          rows: (rows ?? []) as Record<string, unknown>[],
          warehouse_execution_id: stmt?.getQueryId?.(),
        });
      },
    });
  });
}
```

References:
- https://docs.snowflake.com/en/developer-guide/node-js/nodejs-driver
- https://docs.snowflake.com/en/developer-guide/node-js/nodejs-driver-execute

---

# 11. Athena connector recipe (`src/infrastructure/connectors/athena/connector.ts`)

```ts
import {
  AthenaClient,
  StartQueryExecutionCommand,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  StopQueryExecutionCommand,
} from '@aws-sdk/client-athena';

const athena = new AthenaClient({
  region: process.env.AWS_REGION,
});

export async function executeAthenaQuery(sql: string, timeoutMs = 15000) {
  const started = await athena.send(new StartQueryExecutionCommand({
    QueryString: sql,
    WorkGroup: process.env.ATHENA_WORKGROUP,
    ResultConfiguration: {
      OutputLocation: process.env.ATHENA_OUTPUT_S3,
    },
  }));

  const queryExecutionId = started.QueryExecutionId!;
  const startedAt = Date.now();

  while (true) {
    const statusResp = await athena.send(
      new GetQueryExecutionCommand({ QueryExecutionId: queryExecutionId })
    );

    const state = statusResp.QueryExecution?.Status?.State;

    if (state === 'SUCCEEDED') break;
    if (state === 'FAILED' || state === 'CANCELLED') {
      throw new Error(`ATHENA_${state}`);
    }

    if (Date.now() - startedAt > timeoutMs) {
      await athena.send(new StopQueryExecutionCommand({ QueryExecutionId: queryExecutionId }));
      throw new Error('ATHENA_TIMEOUT');
    }

    await new Promise((r) => setTimeout(r, 750));
  }

  const results = await athena.send(
    new GetQueryResultsCommand({ QueryExecutionId: queryExecutionId })
  );

  const rows = results.ResultSet?.Rows ?? [];

  return {
    warehouse_execution_id: queryExecutionId,
    raw_rows: rows,
  };
}
```

References:
- https://docs.aws.amazon.com/athena/latest/APIReference/API_StartQueryExecution.html
- https://docs.aws.amazon.com/athena/latest/APIReference/API_GetQueryResults.html
- https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html

---

# 12. MotherDuck connector recipe (`src/infrastructure/connectors/motherduck/connector.ts`)

```ts
import { DuckDBInstance } from '@duckdb/node-api';

export async function executeMotherDuckQuery(sql: string) {
  const database = process.env.MOTHERDUCK_DATABASE ?? 'my_db';
  const instance = await DuckDBInstance.create(`md:${database}`);
  const connection = await instance.connect();

  const reader = await connection.runAndReadAll(sql);
  const rows = reader.getRowObjects() as Record<string, unknown>[];

  return {
    rows,
  };
}
```

MotherDuck docs also show:
- `DuckDBInstance.fromCache(...)` for reuse
- `motherduck_token` auto-detection
- `session_hint` and read-scaling options

Reference:
- https://motherduck.com/docs/key-tasks/authenticating-and-connecting-to-motherduck/connecting-to-motherduck/

---

# 13. SQL validator skeleton (`src/domain/sql/validation.ts`)

```ts
const FORBIDDEN_KEYWORDS = [
  'INSERT', 'UPDATE', 'DELETE', 'MERGE',
  'CREATE', 'ALTER', 'DROP', 'TRUNCATE',
  'GRANT', 'REVOKE',
  'COPY', 'UNLOAD',
  'CALL', 'PUT', 'GET',
  'USE', 'SET',
];

export function validateReadOnlySql(sql: string): { ok: true } | { ok: false; reason: string } {
  const normalized = sql.trim().toUpperCase();

  if (!normalized) {
    return { ok: false, reason: 'empty_sql' };
  }

  // conservative v1: no multiple statements
  if (normalized.split(';').filter(Boolean).length > 1) {
    return { ok: false, reason: 'multiple_statements' };
  }

  const startsReadOnly =
    normalized.startsWith('SELECT ') || normalized.startsWith('WITH ');

  if (!startsReadOnly) {
    return { ok: false, reason: 'not_read_only' };
  }

  if (FORBIDDEN_KEYWORDS.some((kw) => normalized.includes(kw))) {
    return { ok: false, reason: 'forbidden_keyword' };
  }

  return { ok: true };
}
```

This is intentionally conservative. Stage 2 may replace or augment this with parser-based object extraction.

---

# 14. MCP registration recipe (`src/infrastructure/mcp/server.ts`)

The official MCP SDK quickstart shows `McpServer` tool registration with Zod. Keep the registration generated from the canonical tool registry.

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { toolRegistry } from '../../domain/tools/tool-registry.js';

export function buildMcpServer(execute: (name: string, input: unknown) => Promise<unknown>) {
  const server = new McpServer({
    name: 'agent-data-access-gateway',
    version: '1.0.0',
  });

  for (const tool of toolRegistry) {
    // In the real code, convert the Zod object schema into the SDK input shape if needed
    server.tool(
      tool.name,
      (tool.inputSchema as z.ZodObject<any>).shape,
      async (input) => {
        const result = await execute(tool.name, input);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result),
            },
          ],
        };
      },
    );
  }

  return server;
}
```

For remote servers, the official SDK documents Streamable HTTP as the recommended transport.
Reference:
- https://github.com/modelcontextprotocol/typescript-sdk

Important note:
- verify the exact transport setup against the current SDK version in `docs/server.md` or the examples in `src/examples/server/simpleStreamableHttp.ts`
- keep your own business execution function independent from the transport specifics

---

# 15. Audit table SQL example

```sql
create table audit_events (
  audit_id uuid primary key,
  occurred_at timestamptz not null default now(),
  request_id text not null,
  trace_id text null,
  principal_type text not null,
  principal_id text not null,
  principal_display_name text null,
  client_name text null,
  tool_name text not null,
  tool_version text not null,
  data_source text null,
  input_sha256 text not null,
  input_preview_redacted jsonb null,
  policy_effect text not null,
  policy_reason text not null,
  limits_applied jsonb not null,
  latency_ms integer null,
  rows_returned integer null,
  truncated boolean not null default false,
  warehouse_execution_id text null,
  error_code text null,
  error_message_safe text null
);

create index idx_audit_events_occurred_at on audit_events (occurred_at desc);
create index idx_audit_events_principal on audit_events (principal_id, occurred_at desc);
create index idx_audit_events_tool on audit_events (tool_name, occurred_at desc);
create index idx_audit_events_source on audit_events (data_source, occurred_at desc);
```

---

# 16. Claude Code onboarding examples

## Stage 1 bearer auth
```bash
claude mcp add \
  --transport http \
  company-data \
  https://agent-data.example.com/mcp \
  --header "Authorization: Bearer <stage1-api-key>" \
  --header "X-Agent-Client: claude-code"
```

## Stage 2 OAuth
Add the server normally, then authenticate in Claude Code:
```bash
claude mcp add \
  --transport http \
  company-data \
  https://agent-data.example.com/mcp
```

Then in Claude Code:
```text
/mcp
```

Reference:
- https://code.claude.com/docs/en/mcp

---

# 17. Cursor `mcp.json` example

```json
{
  "mcpServers": {
    "company-data": {
      "type": "streamable-http",
      "url": "https://agent-data.example.com/mcp",
      "headers": {
        "Authorization": "Bearer <stage1-api-key>",
        "X-Agent-Client": "cursor"
      }
    }
  }
}
```

Reference:
- https://docs.cursor.com/en/context/mcp

---

# 18. Stage 2 protected resource metadata sketch

Implement the well-known endpoint according to the MCP/OAuth protected resource model.

```ts
app.get('/.well-known/oauth-protected-resource', (c) => {
  return c.json({
    resource: 'https://agent-data.example.com/mcp',
    authorization_servers: [process.env.OKTA_ISSUER],
    bearer_methods_supported: ['header'],
    scopes_supported: ['data.query.read', 'data.catalog.read'],
  });
});
```

And on unauthenticated `/mcp` access, return 401 with a bearer challenge.
Exact header details should follow the current MCP auth spec and your chosen resource metadata URL.

Reference:
- https://modelcontextprotocol.io/specification/2025-03-26/basic/authorization

---

# 19. Suggested test layout

```text
tests/
  unit/
    sql-validation.test.ts
    tool-registry.test.ts
    execute-tool.test.ts
    audit-event.test.ts
    auth-api-key.test.ts
    auth-okta.test.ts
  integration/
    snowflake.test.ts
    athena.test.ts
    motherduck.test.ts
    audit-repository.test.ts
  contract/
    tool-schemas.snapshot.test.ts
    mcp-tool-list.test.ts
  smoke/
    mcp-inspector.test.ts
```

## MCP smoke test
Use the official MCP inspector for local/staging validation:
- https://github.com/modelcontextprotocol/inspector

---

# 20. Non-negotiable guardrails checklist
- [ ] no raw tokens in logs
- [ ] no write/admin SQL reaches connectors
- [ ] all allow/deny/failure paths write audit
- [ ] output is bounded
- [ ] MCP and Tool API use the same registry and use case
- [ ] Stage 2 uses Okta **access tokens** from a **custom auth server**
- [ ] authorization remains in the application layer
