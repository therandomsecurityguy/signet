import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { AnySchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import type { Hono } from 'hono';

import type { ExecuteToolUseCase } from '../../application/usecases/execute-tool.js';
import type { ToolRegistry } from '../../domain/tools/tool-registry.js';
import type { AppEnv } from '../server.js';

export function registerMcpRoutes(
  app: Hono<AppEnv>,
  deps: {
    registry: ToolRegistry;
    executeTool: ExecuteToolUseCase;
  },
) {
  app.all('/mcp', async (c) => {
    const principal = c.get('principal');
    if (!principal) {
      return c.json(
        { error: { code: 'AUTH_UNAUTHENTICATED', message: 'Unauthorized.' } },
        401,
      );
    }

    const client_name = c.req.header('X-Agent-Client') ?? 'unknown';
    const request_id = c.get('requestId');

    const transport = new WebStandardStreamableHTTPServerTransport();
    const server = buildMcpServer({
      registry: deps.registry,
      executeTool: deps.executeTool,
      principal,
      request_id,
      client_name,
    });

    await server.connect(transport);
    return await transport.handleRequest(c.req.raw);
  });
}

function buildMcpServer(input: {
  registry: ToolRegistry;
  executeTool: ExecuteToolUseCase;
  principal: NonNullable<AppEnv['Variables']['principal']>;
  request_id: string;
  client_name: string;
}) {
  const server = new McpServer({
    name: 'agent-data-access-gateway',
    version: '0.1.0',
  });

  for (const tool of input.registry.list()) {
    server.registerTool(
      tool.name,
      {
        title: tool.name,
        description: tool.description,
        // Pass canonical Zod schema through (supports refinements).
        inputSchema: tool.inputSchema as unknown as AnySchema,
        outputSchema: tool.outputSchema as unknown as AnySchema,
        annotations: { readOnlyHint: true },
      },
      async (args: unknown, _extra: unknown) => {
        const res = await input.executeTool.execute({
          tool_name: tool.name,
          principal: input.principal,
          raw_input: args,
          ctx: { request_id: input.request_id, client_name: input.client_name },
        });

        if (res.error || res.result === null) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(res.error ?? { code: 'INTERNAL_ERROR', message: 'Internal error.' }) }],
            isError: true,
          };
        }

        return {
          structuredContent: res.result as Record<string, unknown>,
          content: [{ type: 'text' as const, text: JSON.stringify(res.result) }],
        };
      },
    );
  }

  return server;
}

