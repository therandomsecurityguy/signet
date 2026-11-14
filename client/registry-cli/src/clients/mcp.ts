import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import { sha256Hex } from './verify.js';

export class RegistryOperatorMcpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistryOperatorMcpError';
  }
}

export class RegistryOperatorMcpClient {
  constructor(private readonly deps: { mcpOrigin: string; extraHeaders?: Record<string, string> }) {}

  async verifyBootstrap(input: {
    token: string;
    agentKeys: string[];
    skillKeys: string[];
  }): Promise<{
    toolsChecked: string[];
    verifiedArtifacts: string[];
    artifactChecks: Array<{
      artifact_urn: string;
      sha256: string | null;
      digest_verified: boolean;
      content_hash_matches: boolean | null;
    }>;
  }> {
    const client = new Client({ name: 'registry-operator', version: '0.1.0' });
    const transport = new StreamableHTTPClientTransport(new URL('/mcp', this.deps.mcpOrigin), {
      requestInit: {
        headers: {
          authorization: `Bearer ${input.token}`,
          'x-agent-client': 'registry-operator',
          ...(this.deps.extraHeaders ?? {}),
        },
      },
    });

    try {
      await client.connect(transport as unknown as Transport);

      const tools = await client.listTools();
      const toolNames = tools.tools.map((tool) => tool.name);
      for (const required of [
        'registry.list_agents',
        'registry.get_agent',
        'registry.list_skills',
        'registry.get_skill',
        'registry.get_artifact',
      ]) {
        if (!toolNames.includes(required)) {
          throw new RegistryOperatorMcpError(`Missing MCP tool: ${required}`);
        }
      }

      await expectToolSuccess(await client.callTool({ name: 'registry.list_agents', arguments: {} }));
      await expectToolSuccess(await client.callTool({ name: 'registry.list_skills', arguments: {} }));

      const verifiedArtifacts: string[] = [];
      const artifactChecks: Array<{
        artifact_urn: string;
        sha256: string | null;
        digest_verified: boolean;
        content_hash_matches: boolean | null;
      }> = [];

      for (const agentKey of input.agentKeys) {
        const result = await expectToolSuccess(
          await client.callTool({
            name: 'registry.get_agent',
            arguments: { agent_urn: `urn:tg:agent:${agentKey}` },
          }),
        );
        const artifacts = readArtifacts(result, 'artifacts');
        for (const artifactUrn of artifacts) {
          artifactChecks.push(await verifyArtifactDigest(client, artifactUrn));
          verifiedArtifacts.push(artifactUrn);
        }
      }

      for (const skillKey of input.skillKeys) {
        const result = await expectToolSuccess(
          await client.callTool({
            name: 'registry.get_skill',
            arguments: { skill_urn: `urn:tg:skill:${skillKey}` },
          }),
        );
        const artifacts = readArtifacts(result, 'artifacts');
        for (const artifactUrn of artifacts) {
          artifactChecks.push(await verifyArtifactDigest(client, artifactUrn));
          verifiedArtifacts.push(artifactUrn);
        }
      }

      return { toolsChecked: toolNames, verifiedArtifacts, artifactChecks };
    } finally {
      await transport.close().catch(() => undefined);
      await client.close().catch(() => undefined);
    }
  }
}

async function expectToolSuccess(result: unknown): Promise<Record<string, unknown>> {
  if ((result as { isError?: boolean }).isError) {
    throw new RegistryOperatorMcpError(readTextContent(result));
  }
  return readStructuredContent(result);
}

// Fetches an artifact through MCP and verifies it locally: the registry
// reports digest_verified, and when the content is not truncated the bytes
// returned are re-hashed against the declared digest. A mismatch fails the
// check; truncation is recorded as an unknown content hash rather than a pass.
async function verifyArtifactDigest(
  client: Client,
  artifactUrn: string,
): Promise<{
  artifact_urn: string;
  sha256: string | null;
  digest_verified: boolean;
  content_hash_matches: boolean | null;
}> {
  const result = await expectToolSuccess(
    await client.callTool({
      name: 'registry.get_artifact',
      arguments: { artifact_urn: artifactUrn },
    }),
  );
  const sha256 = typeof result['sha256'] === 'string' && result['sha256'].length > 0 ? result['sha256'] : null;
  const content = typeof result['content'] === 'string' ? result['content'] : undefined;
  const truncated = result['content_truncated'] === true;
  const digestVerified = result['digest_verified'] === true;
  const contentHashMatches =
    !truncated && sha256 !== null && content !== undefined ? sha256Hex(content) === sha256 : null;

  if (!digestVerified || contentHashMatches === false) {
    throw new RegistryOperatorMcpError(
      `Artifact ${artifactUrn} failed digest verification (digest_verified=${digestVerified}, content_hash_matches=${contentHashMatches ?? 'unknown'}).`,
    );
  }
  return { artifact_urn: artifactUrn, sha256, digest_verified: digestVerified, content_hash_matches: contentHashMatches };
}

function readStructuredContent(result: unknown): Record<string, unknown> {
  return ((result as { structuredContent?: Record<string, unknown> }).structuredContent ?? {}) as Record<string, unknown>;
}

function readTextContent(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  const first = content[0];
  return first?.type === 'text' ? (first.text ?? '') : '';
}

function readArtifacts(result: Record<string, unknown>, key: string): string[] {
  const raw = result[key];
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((item) => (typeof item === 'object' && item && typeof (item as { artifact_urn?: unknown }).artifact_urn === 'string'
      ? (item as { artifact_urn: string }).artifact_urn
      : null))
    .filter((value): value is string => Boolean(value));
}
