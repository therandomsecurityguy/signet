import { createHash, randomUUID } from 'node:crypto';

import { ErrorCode } from '../../domain/errors/error-codes.js';
import { DomainError } from '../../domain/errors/domain-error.js';
import type { PolicyDecision } from '../../domain/policy/policy-decision.js';
import type { Principal } from '../../domain/principal/principal.js';
import type { ToolRegistry } from '../../domain/tools/tool-registry.js';
import { ToolName } from '../../domain/tools/tool-names.js';
import type { AuditPublisher } from '../ports/audit-publisher.js';
import type { CognitiveService } from '../ports/cognitive-service.js';
import type { PolicyService } from '../ports/policy-service.js';
import type { ExecutionContext, WarehouseConnector } from '../ports/warehouse-connector.js';
import type { RegistryConnector } from '../ports/registry-connector.js';
import type { DataDescribeTableInput } from '../../contracts/tools/data-describe-table.js';
import type { DataListTablesInput } from '../../contracts/tools/data-list-tables.js';
import type { DataQueryInput } from '../../contracts/tools/data-query.js';
import type { DataQueryOutput } from '../../contracts/tools/data-query.js';
import type { RegistryGetAgentInput } from '../../contracts/tools/registry-get-agent.js';
import type { RegistryGetArtifactInput, RegistryGetArtifactOutput } from '../../contracts/tools/registry-get-artifact.js';
import type { RegistryGetProvenanceInput } from '../../contracts/tools/registry-get-provenance.js';
import type { RegistryVerifyPublicationInput } from '../../contracts/tools/registry-verify-publication.js';
import type { RegistryGetAttestationsInput } from '../../contracts/tools/registry-get-attestations.js';
import type { RegistryGetSkillInput } from '../../contracts/tools/registry-get-skill.js';
import type { RegistryListAgentsInput } from '../../contracts/tools/registry-list-agents.js';
import type { RegistryListSkillsInput } from '../../contracts/tools/registry-list-skills.js';
import type { RegistrySearchInput } from '../../contracts/tools/registry-search.js';

export type ExecuteToolRequest = {
  tool_name: string;
  principal: Principal;
  raw_input: unknown;
  ctx: ExecutionContext;
};

export type ExecuteToolResponse = {
  audit_id: string;
  decision: PolicyDecision;
  result: unknown | null;
  error: { code: string; message: string } | null;
};

export class ExecuteToolUseCase {
  constructor(
    private readonly deps: {
      registry: ToolRegistry;
      policy: PolicyService;
      warehouse: WarehouseConnector;
      registryConnector: RegistryConnector;
      audit: AuditPublisher;
      cognitive: CognitiveService;
    },
  ) {}

  async execute(req: ExecuteToolRequest): Promise<ExecuteToolResponse> {
    const audit_id = randomUUID();
    const occurred_at = new Date();
    const tool = this.deps.registry.get(req.tool_name);

    if (!tool) {
      throw new DomainError({
        code: ErrorCode.ToolNotFound,
        httpStatus: 404,
        safeMessage: 'Tool not found.',
      });
    }

    let parsedInput: unknown;
    try {
      parsedInput = tool.inputSchema.parse(req.raw_input);
    } catch {
      throw new DomainError({
        code: ErrorCode.ValidationError,
        httpStatus: 400,
        safeMessage: 'Invalid tool input.',
      });
    }

    const decision = await this.deps.policy.evaluate({
      principal: req.principal,
      tool_name: tool.name,
      parsed_input: parsedInput,
    });

    if (decision.effect === 'deny') {
      const data_source = extractDataSource(parsedInput);
      const input = buildInputAudit(parsedInput, tool.name);
      const errorCode = mapPolicyDenyToErrorCode(tool.name, decision.reason);
      await this.deps.audit.publishToolExecution({
        audit_id,
        request_id: req.ctx.request_id,
        client_name: req.ctx.client_name,
        principal: req.principal,
        tool_name: tool.name,
        tool_version: tool.version,
        ...(data_source ? { data_source } : {}),
        input_sha256: input.sha256,
        input_preview_redacted: input.preview_redacted,
        decision,
        error_code: errorCode,
        occurred_at,
      });

      return {
        audit_id,
        decision,
        result: null,
        error: {
          code: errorCode,
          message: safeErrorMessage(errorCode),
        },
      };
    }

    const data_source = extractDataSource(parsedInput);
    const input = buildInputAudit(parsedInput, tool.name);

    try {
      const rawResult = await withTimeout(
        executeToolByName(tool.name, parsedInput, req.ctx, {
          warehouse: this.deps.warehouse,
          registry: this.deps.registryConnector,
        }),
        decision.limits_applied.timeout_ms,
      );

      const shapedResult = shapeResult(tool.name, rawResult, decision.limits_applied);

      const cognitiveResult = await this.deps.cognitive.shape({
        principal: req.principal,
        tool_name: tool.name,
        input_sha256: input.sha256,
        result: shapedResult,
      });

      await this.deps.audit.publishToolExecution({
        audit_id,
        request_id: req.ctx.request_id,
        client_name: req.ctx.client_name,
        principal: req.principal,
        tool_name: tool.name,
        tool_version: tool.version,
        ...(data_source ? { data_source } : {}),
        input_sha256: input.sha256,
        input_preview_redacted: input.preview_redacted,
        decision,
        occurred_at,
      });

      return {
        audit_id,
        decision,
        result: cognitiveResult.result,
        error: null,
      };
    } catch (err) {
      const errorCode = err instanceof DomainError ? err.code : ErrorCode.InternalError;

      await this.deps.audit.publishToolExecution({
        audit_id,
        request_id: req.ctx.request_id,
        client_name: req.ctx.client_name,
        principal: req.principal,
        tool_name: tool.name,
        tool_version: tool.version,
        ...(data_source ? { data_source } : {}),
        input_sha256: input.sha256,
        input_preview_redacted: input.preview_redacted,
        decision,
        error_code: errorCode,
        occurred_at,
      });

      if (err instanceof DomainError) {
        return {
          audit_id,
          decision,
          result: null,
          error: { code: err.code, message: err.safeMessage },
        };
      }

      return {
        audit_id,
        decision,
        result: null,
        error: { code: ErrorCode.InternalError, message: safeErrorMessage(ErrorCode.InternalError) },
      };
    }
  }
}

function extractDataSource(parsedInput: unknown): string | undefined {
  if (!parsedInput || typeof parsedInput !== 'object') return undefined;
  const value = (parsedInput as Record<string, unknown>)['data_source'];
  return typeof value === 'string' ? value : undefined;
}

async function executeToolByName(
  toolName: string,
  parsedInput: unknown,
  ctx: ExecutionContext,
  connectors: {
    warehouse: WarehouseConnector;
    registry: RegistryConnector;
  },
): Promise<unknown> {
  // Intentionally explicit dispatch. Tool contracts are small and stable.
  switch (toolName) {
    case ToolName.DataQuery:
      return await connectors.warehouse.executeQuery(parsedInput as DataQueryInput, ctx);
    case ToolName.DataListTables:
      return await connectors.warehouse.listTables(parsedInput as DataListTablesInput, ctx);
    case ToolName.DataDescribeTable:
      return await connectors.warehouse.describeTable(parsedInput as DataDescribeTableInput, ctx);

    case ToolName.RegistryListAgents:
      return await connectors.registry.listAgents(parsedInput as RegistryListAgentsInput, ctx);
    case ToolName.RegistryGetAgent:
      return await connectors.registry.getAgent(parsedInput as RegistryGetAgentInput, ctx);
    case ToolName.RegistryListSkills:
      return await connectors.registry.listSkills(parsedInput as RegistryListSkillsInput, ctx);
    case ToolName.RegistryGetSkill:
      return await connectors.registry.getSkill(parsedInput as RegistryGetSkillInput, ctx);
    case ToolName.RegistryGetArtifact:
      return await connectors.registry.getArtifact(parsedInput as RegistryGetArtifactInput, ctx);
    case ToolName.RegistryGetProvenance:
      return await connectors.registry.getProvenance(parsedInput as RegistryGetProvenanceInput, ctx);
    case ToolName.RegistryVerifyPublication:
      return await connectors.registry.verifyPublication(parsedInput as RegistryVerifyPublicationInput, ctx);
    case ToolName.RegistryGetAttestations:
      return await connectors.registry.getAttestations(parsedInput as RegistryGetAttestationsInput, ctx);
    case ToolName.RegistrySearch:
      return await connectors.registry.search(parsedInput as RegistrySearchInput, ctx);
    default:
      // This should be unreachable if registry is the source of truth.
      throw new DomainError({
        code: ErrorCode.ToolNotFound,
        httpStatus: 404,
        safeMessage: 'Tool not found.',
      });
  }
}

function buildInputAudit(
  parsedInput: unknown,
  toolName: string,
): { sha256: string; preview_redacted: Record<string, unknown> } {
  const json = safeStableStringify(parsedInput);
  const sha256 = createHash('sha256').update(json, 'utf8').digest('hex');
  const preview_redacted = redactPreview(parsedInput, toolName);
  return { sha256, preview_redacted };
}

function safeStableStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '"[unstringifiable]"';
  }
}

function redactPreview(value: unknown, toolName: string): Record<string, unknown> {
  if (!value || typeof value !== 'object') {
    return { value: '[non_object]' };
  }

  const obj = { ...(value as Record<string, unknown>) };

  if (toolName === ToolName.DataQuery && typeof obj['sql'] === 'string') {
    const sql = obj['sql'] as string;
    obj['sql_sha256'] = createHash('sha256').update(sql, 'utf8').digest('hex');
    obj['sql_length'] = sql.length;
    obj['sql'] = '[REDACTED]';
  }

  // Defensive removal if callers ever add secret-like fields.
  for (const key of ['token', 'access_token', 'refresh_token', 'password', 'connection_string']) {
    if (key in obj) {
      obj[key] = '[REDACTED]';
    }
  }

  return obj;
}

function mapPolicyDenyToErrorCode(toolName: string, reason: string) {
  const sqlReasons = new Set([
    'empty_sql',
    'multiple_statements',
    'not_select_or_with',
    'has_comments',
    'forbidden_keyword',
    'not_read_only',
  ]);

  if (toolName === ToolName.DataQuery && sqlReasons.has(reason)) return ErrorCode.SqlNotReadOnly;
  return ErrorCode.AuthForbidden;
}

function safeErrorMessage(code: string): string {
  switch (code) {
    case ErrorCode.SqlNotReadOnly:
      return 'Only single-statement read-only queries are allowed.';
    case ErrorCode.ConnectorTimeout:
      return 'The request timed out.';
    case ErrorCode.ResultTooLarge:
      return 'Result too large.';
    case ErrorCode.AuthUnauthenticated:
      return 'Unauthorized.';
    case ErrorCode.AuthForbidden:
      return 'Access denied.';
    case ErrorCode.RegistryEntityNotFound:
      return 'Registry entity not found.';
    case ErrorCode.RegistryArtifactNotFound:
      return 'Registry artifact not found.';
    case ErrorCode.ValidationError:
      return 'Invalid tool input.';
    case ErrorCode.ToolNotFound:
      return 'Tool not found.';
    default:
      return 'Internal error.';
  }
}

async function withTimeout<T>(p: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new DomainError({
          code: ErrorCode.ConnectorTimeout,
          httpStatus: 504,
          safeMessage: safeErrorMessage(ErrorCode.ConnectorTimeout),
        }),
      );
    }, timeoutMs);
  });

  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function shapeResult(
  toolName: string,
  rawResult: unknown,
  limits: { max_rows: number; max_output_bytes: number },
): unknown {
  if (toolName === ToolName.DataQuery) {
    return truncateQueryOutput(rawResult as DataQueryOutput, limits.max_rows, limits.max_output_bytes);
  }
  if (toolName === ToolName.RegistryGetArtifact) {
    return truncateArtifactOutput(rawResult as RegistryGetArtifactOutput, limits.max_output_bytes);
  }
  return rawResult;
}

function truncateArtifactOutput(
  input: RegistryGetArtifactOutput,
  maxBytes: number,
): RegistryGetArtifactOutput {
  const bytes = Buffer.from(input.content, 'utf8');
  if (bytes.length <= maxBytes) return input;

  const truncated = bytes.subarray(0, maxBytes);
  return {
    ...input,
    content: truncated.toString('utf8'),
    content_truncated: true,
  };
}

function truncateQueryOutput(
  input: DataQueryOutput,
  maxRows: number,
  maxBytes: number,
): DataQueryOutput {
  const rows = input.rows.slice(0, Math.max(0, maxRows));
  let truncated = input.truncated || rows.length < input.rows.length;

  while (Buffer.byteLength(JSON.stringify({ ...input, rows, row_count_returned: rows.length, truncated }), 'utf8') > maxBytes && rows.length > 0) {
    rows.pop();
    truncated = true;
  }

  const result: DataQueryOutput = {
    ...input,
    rows,
    row_count_returned: rows.length,
    truncated,
  };

  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > maxBytes) {
    throw new DomainError({
      code: ErrorCode.ResultTooLarge,
      httpStatus: 413,
      safeMessage: safeErrorMessage(ErrorCode.ResultTooLarge),
    });
  }

  return result;
}

