import { describe, expect, it, vi } from 'vitest';

import type { AuditPublisher } from '../../src/application/ports/audit-publisher.js';
import type { CognitiveService } from '../../src/application/ports/cognitive-service.js';
import type { PolicyService } from '../../src/application/ports/policy-service.js';
import type { RegistryConnector } from '../../src/application/ports/registry-connector.js';
import type { WarehouseConnector } from '../../src/application/ports/warehouse-connector.js';
import { ExecuteToolUseCase } from '../../src/application/usecases/execute-tool.js';
import { ErrorCode } from '../../src/domain/errors/error-codes.js';
import { DomainError } from '../../src/domain/errors/domain-error.js';
import { ToolRegistry } from '../../src/domain/tools/tool-registry.js';

const anonymousPrincipal = {
  type: 'anonymous' as const,
  id: 'anonymous' as const,
  authMethod: 'none' as const,
  scopes: [],
  groups: [],
  claims: {},
};

const noopRegistryConnector = {
  listAgents: vi.fn(),
  getAgent: vi.fn(),
  listSkills: vi.fn(),
  getSkill: vi.fn(),
  getArtifact: vi.fn(),
  getProvenance: vi.fn(),
  verifyPublication: vi.fn(),
  getAttestations: vi.fn(),
  search: vi.fn(),
} satisfies RegistryConnector;

const noopCognitive = {
  shape: vi.fn(async ({ result }: { result: unknown }) => ({ result, summarized: false, estimated_tokens: 0 })),
} satisfies CognitiveService;

describe('ExecuteToolUseCase', () => {
  it('throws TOOL_NOT_FOUND for unknown tools', async () => {
    const useCase = new ExecuteToolUseCase({
      registry: ToolRegistry.buildDefault(),
      policy: { evaluate: vi.fn() } satisfies PolicyService,
      warehouse: {} as unknown as WarehouseConnector,
      registryConnector: noopRegistryConnector,
      audit: {
        publishToolExecution: vi.fn(),
        publishAuthEvent: vi.fn(),
      } satisfies AuditPublisher,
      cognitive: noopCognitive,
    });

    await expect(
      useCase.execute({
        tool_name: 'nope',
        principal: anonymousPrincipal,
        raw_input: {},
        ctx: { request_id: 'r1', client_name: 'test' },
      }),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it('returns VALIDATION_ERROR for invalid input', async () => {
    const useCase = new ExecuteToolUseCase({
      registry: ToolRegistry.buildDefault(),
      policy: { evaluate: vi.fn() } satisfies PolicyService,
      warehouse: {} as unknown as WarehouseConnector,
      registryConnector: noopRegistryConnector,
      audit: {
        publishToolExecution: vi.fn(),
        publishAuthEvent: vi.fn(),
      } satisfies AuditPublisher,
      cognitive: noopCognitive,
    });

    await expect(
      useCase.execute({
        tool_name: 'data.query',
        principal: anonymousPrincipal,
        raw_input: { data_source: 'snowflake' }, // missing sql
        ctx: { request_id: 'r1', client_name: 'test' },
      }),
    ).rejects.toMatchObject({ code: ErrorCode.ValidationError });
  });

  it('audits and returns a result on allow', async () => {
    const audit = {
      publishToolExecution: vi.fn(),
      publishAuthEvent: vi.fn(),
    } satisfies AuditPublisher;
    const policy = {
      evaluate: vi.fn(async () => ({
        effect: 'allow' as const,
        reason: 'ok',
        limits_applied: { max_rows: 50, timeout_ms: 15_000, max_output_bytes: 65_536 },
      })),
    } satisfies PolicyService;
    const connector = {
      executeQuery: vi.fn(async () => ({
        columns: [{ name: 'one' }],
        rows: [{ one: 1 }],
        row_count_returned: 1,
        truncated: false,
      })),
    } as unknown as WarehouseConnector;

    const useCase = new ExecuteToolUseCase({
      registry: ToolRegistry.buildDefault(),
      policy,
      warehouse: connector,
      registryConnector: noopRegistryConnector,
      audit,
      cognitive: noopCognitive,
    });

    const res = await useCase.execute({
      tool_name: 'data.query',
      principal: anonymousPrincipal,
      raw_input: { data_source: 'snowflake', sql: 'select 1' },
      ctx: { request_id: 'r1', client_name: 'test' },
    });

    expect(res.error).toBeNull();
    expect(res.result).toMatchObject({ row_count_returned: 1, truncated: false });
    expect(audit.publishToolExecution).toHaveBeenCalledTimes(1);
  });

  it('audits and returns a deny envelope when policy denies', async () => {
    const audit = {
      publishToolExecution: vi.fn(),
      publishAuthEvent: vi.fn(),
    } satisfies AuditPublisher;
    const policy = {
      evaluate: vi.fn(async () => ({
        effect: 'deny' as const,
        reason: 'nope',
        limits_applied: { max_rows: 50, timeout_ms: 15_000, max_output_bytes: 65_536 },
      })),
    } satisfies PolicyService;

    const connector = {
      executeQuery: vi.fn(),
    } as unknown as WarehouseConnector;

    const useCase = new ExecuteToolUseCase({
      registry: ToolRegistry.buildDefault(),
      policy,
      warehouse: connector,
      registryConnector: noopRegistryConnector,
      audit,
      cognitive: noopCognitive,
    });

    const res = await useCase.execute({
      tool_name: 'data.query',
      principal: anonymousPrincipal,
      raw_input: { data_source: 'snowflake', sql: 'select 1' },
      ctx: { request_id: 'r1', client_name: 'test' },
    });

    expect(res.result).toBeNull();
    expect(res.error).toMatchObject({ code: ErrorCode.AuthForbidden });
    expect(audit.publishToolExecution).toHaveBeenCalledTimes(1);
    expect(connector.executeQuery).not.toHaveBeenCalled();
  });

  it('truncates data.query rows to max_rows', async () => {
    const audit = {
      publishToolExecution: vi.fn(),
      publishAuthEvent: vi.fn(),
    } satisfies AuditPublisher;

    const policy = {
      evaluate: vi.fn(async () => ({
        effect: 'allow' as const,
        reason: 'ok',
        limits_applied: { max_rows: 2, timeout_ms: 15_000, max_output_bytes: 65_536 },
      })),
    } satisfies PolicyService;

    const connector = {
      executeQuery: vi.fn(async () => ({
        columns: [{ name: 'n' }],
        rows: [{ n: 1 }, { n: 2 }, { n: 3 }],
        row_count_returned: 3,
        truncated: false,
      })),
    } as unknown as WarehouseConnector;

    const useCase = new ExecuteToolUseCase({
      registry: ToolRegistry.buildDefault(),
      policy,
      warehouse: connector,
      registryConnector: noopRegistryConnector,
      audit,
      cognitive: noopCognitive,
    });

    const res = await useCase.execute({
      tool_name: 'data.query',
      principal: anonymousPrincipal,
      raw_input: { data_source: 'snowflake', sql: 'select 1' },
      ctx: { request_id: 'r1', client_name: 'test' },
    });

    expect(res.error).toBeNull();
    expect(res.result).toMatchObject({
      row_count_returned: 2,
      truncated: true,
    });
  });

  it('applies the cognitive layer to the tool result', async () => {
    const audit = {
      publishToolExecution: vi.fn(),
      publishAuthEvent: vi.fn(),
    } satisfies AuditPublisher;

    const policy = {
      evaluate: vi.fn(async () => ({
        effect: 'allow' as const,
        reason: 'ok',
        limits_applied: { max_rows: 50, timeout_ms: 15_000, max_output_bytes: 65_536 },
      })),
    } satisfies PolicyService;

    const connector = {
      executeQuery: vi.fn(async () => ({
        columns: [{ name: 'n' }],
        rows: [{ n: 1 }],
        row_count_returned: 1,
        truncated: false,
      })),
    } as unknown as WarehouseConnector;

    const summarizedResult = { _summarized: true, reason: 'context_budget_exceeded' };
    const cognitive = {
      shape: vi.fn(async () => ({ result: summarizedResult, summarized: true, estimated_tokens: 9000 })),
    } satisfies CognitiveService;

    const useCase = new ExecuteToolUseCase({
      registry: ToolRegistry.buildDefault(),
      policy,
      warehouse: connector,
      registryConnector: noopRegistryConnector,
      audit,
      cognitive,
    });

    const res = await useCase.execute({
      tool_name: 'data.query',
      principal: anonymousPrincipal,
      raw_input: { data_source: 'snowflake', sql: 'select 1' },
      ctx: { request_id: 'r1', client_name: 'test' },
    });

    expect(res.error).toBeNull();
    expect(cognitive.shape).toHaveBeenCalledTimes(1);
    expect(res.result).toEqual(summarizedResult);
  });

  it('returns explicit not-found for missing registry entities', async () => {
    const audit = {
      publishToolExecution: vi.fn(),
      publishAuthEvent: vi.fn(),
    } satisfies AuditPublisher;
    const policy = {
      evaluate: vi.fn(async () => ({
        effect: 'allow' as const,
        reason: 'ok',
        limits_applied: { max_rows: 50, timeout_ms: 15_000, max_output_bytes: 65_536 },
      })),
    } satisfies PolicyService;
    const registryConnector = {
      ...noopRegistryConnector,
      getAgent: vi.fn(async () => {
        throw new DomainError({
          code: ErrorCode.RegistryEntityNotFound,
          httpStatus: 404,
          safeMessage: 'Registry entity not found.',
        });
      }),
    } satisfies RegistryConnector;

    const useCase = new ExecuteToolUseCase({
      registry: ToolRegistry.buildDefault(),
      policy,
      warehouse: {} as unknown as WarehouseConnector,
      registryConnector,
      audit,
      cognitive: noopCognitive,
    });

    const res = await useCase.execute({
      tool_name: 'registry.get_agent',
      principal: anonymousPrincipal,
      raw_input: { agent_urn: 'urn:sg:agent:missing' },
      ctx: { request_id: 'r1', client_name: 'test' },
    });

    expect(res.result).toBeNull();
    expect(res.error).toMatchObject({ code: ErrorCode.RegistryEntityNotFound });
    expect(audit.publishToolExecution).toHaveBeenCalledTimes(1);
  });

  it('dispatches registry.search to the registry connector', async () => {
    const audit = {
      publishToolExecution: vi.fn(),
      publishAuthEvent: vi.fn(),
    } satisfies AuditPublisher;

    const policy = {
      evaluate: vi.fn(async () => ({
        effect: 'allow' as const,
        reason: 'ok',
        limits_applied: { max_rows: 50, timeout_ms: 15_000, max_output_bytes: 65_536 },
      })),
    } satisfies PolicyService;

    const search = vi.fn(async () => ({
      query: 'llama',
      skills: [{ skill_urn: 'urn:sg:skill:skill:tame-llama', skill_key: 'skill:tame-llama' }],
      agents: [],
    }));

    const registryConnector = {
      ...noopRegistryConnector,
      search,
    } satisfies RegistryConnector;

    const useCase = new ExecuteToolUseCase({
      registry: ToolRegistry.buildDefault(),
      policy,
      warehouse: {} as unknown as WarehouseConnector,
      registryConnector,
      audit,
      cognitive: noopCognitive,
    });

    const res = await useCase.execute({
      tool_name: 'registry.search',
      principal: anonymousPrincipal,
      raw_input: { query: 'llama', type: 'all' },
      ctx: { request_id: 'r1', client_name: 'test' },
    });

    expect(res.error).toBeNull();
    expect(search).toHaveBeenCalledTimes(1);
    expect(res.result).toMatchObject({
      query: 'llama',
      skills: [{ skill_key: 'skill:tame-llama' }],
    });
  });
});

