import createClient, { type Middleware } from 'openapi-fetch';

import type { paths } from './generated/api.js';
import { sha256Hex } from './verify.js';

function parseArtifactSha256(urn: string): string | null {
  const match = /^urn:sg:artifact:sha256:([0-9a-f]{64})$/.exec(urn);
  return match?.[1] ?? null;
}

// RFC 9530 Content-Digest structured field: sha-256=:BASE64:
function contentDigestMatches(header: string, sha256HexValue: string): boolean {
  const match = /sha-256=:([^:]+):/.exec(header);
  if (!match) return true;
  return match[1] === Buffer.from(sha256HexValue, 'hex').toString('base64');
}

export type RegistryClientOptions = {
  /** Base URL of the Signet registry API, e.g. `http://localhost:3100`. */
  baseUrl: string;
  /** Bearer token for authenticated reads/writes. */
  apiToken?: string;
  /**
   * Extra headers sent on every request — e.g. the Cloudflare Access
   * service-token headers (`CF-Access-Client-Id` / `CF-Access-Client-Secret`)
   * required for the deployed tunnels.
   */
  headers?: Record<string, string>;
  /** Optional `fetch` implementation (useful for tests). */
  fetch?: typeof fetch;
};

export class RegistryClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'RegistryClientError';
  }
}

type GetResult<T> = { data?: T; error?: unknown; response: Response };

/**
 * Typed, read-first client for the Signet registry API.
 *
 * The read methods mirror the canonical `service/api` contract and are safe
 * for agents to call for discovery, inspection, and trust verification.
 */
export class RegistryClient {
  private readonly client: ReturnType<typeof createClient<paths>>;

  constructor(private readonly options: RegistryClientOptions) {
    const authMiddleware: Middleware = {
      onRequest: ({ request }) => {
        if (this.options.apiToken) {
          request.headers.set('authorization', `Bearer ${this.options.apiToken}`);
        }
        request.headers.set('accept', 'application/json');
        for (const [key, value] of Object.entries(this.options.headers ?? {})) {
          request.headers.set(key, value);
        }
        return request;
      },
    };

    this.client = createClient<paths>({
      baseUrl: options.baseUrl,
      fetch: options.fetch,
    });
    this.client.use(authMiddleware);
  }

  // ---- Skills ----

  async listSkills(input?: { limit?: number; offset?: number }) {
    return this.unwrap(await this.client.GET('/v1/skills', { params: { query: input ?? {} } }));
  }

  async getSkill(skillKey: string) {
    return this.unwrap(await this.client.GET('/v1/skills/{skillKey}', { params: { path: { skillKey } } }));
  }

  async listSkillVersions(skillKey: string) {
    return this.unwrap(await this.client.GET('/v1/skills/{skillKey}/versions', { params: { path: { skillKey } } }));
  }

  async getSkillVersion(skillKey: string, version: number) {
    return this.unwrap(
      await this.client.GET('/v1/skills/{skillKey}/versions/{version}', {
        params: { path: { skillKey, version: String(version) } },
      }),
    );
  }

  async getActiveSkillVersion(skillKey: string) {
    return this.unwrap(await this.client.GET('/v1/skills/{skillKey}/active', { params: { path: { skillKey } } }));
  }

  async getSkillPublicationEnvelope(skillKey: string, version: number) {
    return this.unwrap(
      await this.client.GET('/v1/skills/{skillKey}/versions/{version}/publication-envelope', {
        params: { path: { skillKey, version: String(version) } },
      }),
    );
  }

  async getSkillVerification(skillKey: string, version: number) {
    return this.unwrap(
      await this.client.GET('/v1/skills/{skillKey}/versions/{version}/verification', {
        params: { path: { skillKey, version: String(version) } },
      }),
    );
  }

  async getSkillProvenance(skillKey: string, version: number) {
    return this.unwrap(
      await this.client.GET('/v1/skills/{skillKey}/versions/{version}/provenance', {
        params: { path: { skillKey, version: String(version) } },
      }),
    );
  }

  // ---- Agents ----

  async listAgents(input?: { harness_name?: string; limit?: number; offset?: number }) {
    return this.unwrap(await this.client.GET('/v1/agents', { params: { query: input ?? {} } }));
  }

  async getAgent(agentKey: string) {
    return this.unwrap(await this.client.GET('/v1/agents/{agentKey}', { params: { path: { agentKey } } }));
  }

  async listAgentVersions(agentKey: string) {
    return this.unwrap(await this.client.GET('/v1/agents/{agentKey}/versions', { params: { path: { agentKey } } }));
  }

  async getActiveAgentVersion(agentKey: string) {
    return this.unwrap(await this.client.GET('/v1/agents/{agentKey}/active', { params: { path: { agentKey } } }));
  }

  async getAgentPublicationEnvelope(agentKey: string, version: number) {
    return this.unwrap(
      await this.client.GET('/v1/agents/{agentKey}/versions/{version}/publication-envelope', {
        params: { path: { agentKey, version: String(version) } },
      }),
    );
  }

  async getAgentVerification(agentKey: string, version: number) {
    return this.unwrap(
      await this.client.GET('/v1/agents/{agentKey}/versions/{version}/verification', {
        params: { path: { agentKey, version: String(version) } },
      }),
    );
  }

  async getAgentProvenance(agentKey: string, version: number) {
    return this.unwrap(
      await this.client.GET('/v1/agents/{agentKey}/versions/{version}/provenance', {
        params: { path: { agentKey, version: String(version) } },
      }),
    );
  }

  // ---- Trust / transparency ----

  async listPublicKeys() {
    return this.unwrap(await this.client.GET('/v1/public-keys', {}));
  }

  async getPublicKey(keyRef: string) {
    return this.unwrap(await this.client.GET('/v1/public-keys/{keyRef}', { params: { path: { keyRef } } }));
  }

  async listTransparencyLogs() {
    return this.unwrap(await this.client.GET('/v1/transparency-logs', {}));
  }

  async getTransparencyLog(logId: string) {
    return this.unwrap(await this.client.GET('/v1/transparency-logs/{logId}', { params: { path: { logId } } }));
  }

  async getTransparencyLogVerification(logId: string) {
    return this.unwrap(
      await this.client.GET('/v1/transparency-logs/{logId}/verification', { params: { path: { logId } } }),
    );
  }

  async getTransparencyLogTimeline(logId: string) {
    return this.unwrap(
      await this.client.GET('/v1/transparency-logs/{logId}/timeline', { params: { path: { logId } } }),
    );
  }

  async getGovernanceLog() {
    return this.unwrap(await this.client.GET('/v1/governance-log', {}));
  }

  async getGraphSubgraph(input: { root_urn: string; depth?: number }) {
    return this.unwrap(await this.client.GET('/v1/graph/subgraph', { params: { query: input } }));
  }

  /**
   * Fetch content-addressed artifact bytes and verify them locally: the bytes
   * are re-hashed and compared with the requested digest, and with the
   * `content-digest` header when the server sends one. `digest_verified:
   * false` means the bytes must not be trusted.
   */
  async fetchArtifact(input: { sha256?: string; artifact_urn?: string }): Promise<{
    sha256: string;
    bytes: Uint8Array;
    digest_verified: boolean;
  }> {
    const sha256 = input.sha256 ?? parseArtifactSha256(input.artifact_urn ?? '');
    if (!sha256) {
      throw new RegistryClientError('A sha256 or artifact_urn is required.', 400);
    }
    const result = await this.client.GET('/v1/artifacts/{sha256}', {
      params: { path: { sha256 } },
      parseAs: 'arrayBuffer',
    });
    if (result.response.status !== 200 || !result.data) {
      const errorBody = result.error as { error?: { code?: string; message?: string } } | undefined;
      throw new RegistryClientError(
        errorBody?.error?.message ?? `Artifact fetch failed (${result.response.status})`,
        result.response.status,
        errorBody?.error?.code,
      );
    }
    const bytes = new Uint8Array(result.data);
    const contentDigest = result.response.headers.get('content-digest');
    const headerMatches = contentDigest ? contentDigestMatches(contentDigest, sha256) : true;
    return {
      sha256,
      bytes,
      digest_verified: sha256Hex(bytes) === sha256 && headerMatches,
    };
  }

  private unwrap<T>(result: GetResult<T>): T {
    if (result.error) {
      const errorBody = result.error as { error?: { code?: string; message?: string } };
      throw new RegistryClientError(
        errorBody.error?.message ?? `Registry API request failed (${result.response.status})`,
        result.response.status,
        errorBody.error?.code,
      );
    }
    if (result.data === undefined) {
      throw new RegistryClientError('Registry API returned an empty response.', result.response.status);
    }
    return result.data;
  }
}
