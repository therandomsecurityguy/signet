import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { AnySchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import type { Hono } from 'hono';

import {
  agentUrn,
  skillUrn,
} from '../../../../registry/domain/signet/db/graph/freeform/registry/urn.js';
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
    name: 'signet-mcp',
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

  // Native MCP resources (build plan 3.2c): harnesses attach registry
  // content by URI instead of calling tools and copying bodies. Reads go
  // through the exact same tool execution path, so read gates (revoked /
  // verification), artifact digest verification, and audit all apply.
  const runTool = async (toolName: string, rawInput: Record<string, unknown>): Promise<unknown> => {
    const res = await input.executeTool.execute({
      tool_name: toolName,
      principal: input.principal,
      raw_input: rawInput,
      ctx: { request_id: input.request_id, client_name: input.client_name },
    });
    if (res.error || res.result === null || res.result === undefined) {
      throw new Error(JSON.stringify(res.error ?? { code: 'INTERNAL_ERROR', message: 'Internal error.' }));
    }
    return res.result;
  };

  server.registerResource(
    'signet-index',
    'signet://index',
    {
      title: 'Signet registry index',
      description: 'Published skills and agents, each with its native resource URI (signet://skill/…, signet://agent/…).',
      mimeType: 'application/json',
    },
    async (uri) => {
      const skills = (await runTool('registry.list_skills', {})) as {
        skills: Array<{ skill_key: string; display_name?: string; description?: string }>;
      };
      const agents = (await runTool('registry.list_agents', {})) as {
        agents: Array<{ agent_key: string; display_name?: string; description?: string }>;
      };
      const payload = {
        skills: skills.skills.map((skill) => ({
          uri: `signet://skill/${encodeURIComponent(skill.skill_key)}`,
          key: skill.skill_key,
          ...(skill.display_name ? { display_name: skill.display_name } : {}),
          ...(skill.description ? { description: skill.description } : {}),
        })),
        agents: agents.agents.map((agent) => ({
          uri: `signet://agent/${encodeURIComponent(agent.agent_key)}`,
          key: agent.agent_key,
          ...(agent.display_name ? { display_name: agent.display_name } : {}),
          ...(agent.description ? { description: agent.description } : {}),
        })),
      };
      return {
        contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(payload, null, 2) }],
      };
    },
  );

  const readEntityBody = async (
    entityType: 'skill' | 'agent',
    logicalKey: string,
    uri: URL,
  ): Promise<{ contents: Array<{ uri: string; mimeType: string; text: string }> }> => {
    const details =
      entityType === 'skill'
        ? ((await runTool('registry.get_skill', { skill_urn: skillUrn(logicalKey) })) as {
            active_version?: { artifacts?: Array<{ artifact_urn: string; sha256?: string }> };
          })
        : ((await runTool('registry.get_agent', { agent_urn: agentUrn(logicalKey) })) as {
            active_version?: { artifacts?: Array<{ artifact_urn: string; sha256?: string }> };
          });
    const activeArtifacts = details.active_version?.artifacts ?? [];
    const artifact = activeArtifacts[0];
    if (!artifact) {
      throw new Error(
        JSON.stringify({
          code: 'REGISTRY_RESOURCE_NOT_FOUND',
          message: `No published body for ${logicalKey}.`,
        }),
      );
    }
    const got = (await runTool(
      'registry.get_artifact',
      artifact.sha256 ? { sha256: artifact.sha256 } : { artifact_urn: artifact.artifact_urn },
    )) as { content: string; digest_verified: boolean; media_type?: string };
    if (!got.digest_verified) {
      throw new Error(
        JSON.stringify({
          code: 'REGISTRY_RESOURCE_UNVERIFIED',
          message: `Artifact for ${logicalKey} failed digest verification.`,
        }),
      );
    }
    return {
      contents: [{ uri: uri.href, mimeType: got.media_type ?? 'text/markdown', text: got.content }],
    };
  };

  server.registerResource(
    'signet-skill-body',
    new ResourceTemplate('signet://skill/{skill_key}', { list: undefined }),
    {
      title: 'Skill body',
      description:
        'The body of a published skill’s active version, read through the verified artifact path (revoked and unverified publications are denied by the read gates).',
      mimeType: 'text/markdown',
    },
    async (uri, variables) =>
      await readEntityBody('skill', decodeURIComponent(String(variables['skill_key'] ?? '')), uri),
  );

  server.registerResource(
    'signet-agent-body',
    new ResourceTemplate('signet://agent/{agent_key}', { list: undefined }),
    {
      title: 'Agent body',
      description:
        'The body of a published agent’s active version, read through the verified artifact path (revoked and unverified publications are denied by the read gates).',
      mimeType: 'text/markdown',
    },
    async (uri, variables) =>
      await readEntityBody('agent', decodeURIComponent(String(variables['agent_key'] ?? '')), uri),
  );

  return server;
}

