import type { Env } from '../config/env.js';
import type { PolicyEvaluationInput, PolicyService } from '../../application/ports/policy-service.js';
import type { PolicyDecision } from '../../domain/policy/policy-decision.js';
import { ToolName } from '../../domain/tools/tool-names.js';
import { validateReadOnlySql } from '../../domain/sql/validation.js';
import { extractTableRefs } from '../../domain/sql/object-extraction.js';
import type { AuthzRules } from './authz-rules.js';
import { matchAuthzRule, matchesPattern, parseAuthzRules } from './authz-rules.js';

export class DefaultPolicyService implements PolicyService {
  private readonly authz: AuthzRules | null;

  constructor(private readonly env: Env) {
    this.authz = parseAuthzRules(env.AUTHZ_RULES_JSON);
  }

  async evaluate(input: PolicyEvaluationInput): Promise<PolicyDecision> {
    const limits = mergeLimits(this.env, input.parsed_input);

    // Stage 2 authorization (Phase 9): enforce entitlements when configured.
    // Rules apply to every authenticated principal type, not just Okta users —
    // API keys with no matching rule are denied (fail closed).
    if (this.authz) {
      const rule = matchAuthzRule({ rules: this.authz, groups: input.principal.groups });
      if (!rule) {
        return { effect: 'deny', reason: 'no_matching_entitlement', limits_applied: limits };
      }

      if (rule.allow.tools.length > 0 && !rule.allow.tools.includes(input.tool_name)) {
        return { effect: 'deny', reason: 'tool_not_allowed', limits_applied: limits };
      }

      if (isRegistryTool(input.tool_name)) {
        return { effect: 'allow', reason: 'policy_allow', limits_applied: limits };
      }

      const ds = getDataSource(input.parsed_input);
      if (!ds) return { effect: 'deny', reason: 'missing_data_source', limits_applied: limits };

      const dsRule = rule.allow.data_sources[ds];
      if (!dsRule) return { effect: 'deny', reason: 'source_not_allowed', limits_applied: limits };

      // For metadata tools, enforce database/schema/table patterns if fields are provided.
      if (input.tool_name === ToolName.DataDescribeTable) {
        const database = getString(input.parsed_input, 'database');
        const schema = getString(input.parsed_input, 'schema');
        const table = getString(input.parsed_input, 'table');
        if (!matchesPattern(dsRule.databases, database)) return { effect: 'deny', reason: 'database_not_allowed', limits_applied: limits };
        if (!matchesPattern(dsRule.schemas, schema)) return { effect: 'deny', reason: 'schema_not_allowed', limits_applied: limits };
        if (!matchesPattern(dsRule.tables, table)) return { effect: 'deny', reason: 'table_not_allowed', limits_applied: limits };
      }

      if (input.tool_name === ToolName.DataListTables) {
        const database = getString(input.parsed_input, 'database');
        const schema = getString(input.parsed_input, 'schema');
        if (!matchesPattern(dsRule.databases, database)) return { effect: 'deny', reason: 'database_not_allowed', limits_applied: limits };
        if (!matchesPattern(dsRule.schemas, schema)) return { effect: 'deny', reason: 'schema_not_allowed', limits_applied: limits };
      }

      if (input.tool_name === ToolName.DataQuery) {
        const sql = getString(input.parsed_input, 'sql');
        if (sql) {
          const refs = extractTableRefs(sql);
          // Fail closed when the statement references FROM/JOIN objects that
          // the conservative extractor cannot identify: an unparsed object
          // cannot be checked against the allowlist.
          if (refs.length === 0 && /\b(from|join)\b/i.test(sql)) {
            return { effect: 'deny', reason: 'unparseable_object_refs', limits_applied: limits };
          }
          for (const ref of refs) {
            if (ref.database && !matchesPattern(dsRule.databases, ref.database)) {
              return { effect: 'deny', reason: 'database_not_allowed', limits_applied: limits };
            }
            if (ref.schema && !matchesPattern(dsRule.schemas, ref.schema)) {
              return { effect: 'deny', reason: 'schema_not_allowed', limits_applied: limits };
            }
            if (!matchesPattern(dsRule.tables, ref.table)) {
              return { effect: 'deny', reason: 'table_not_allowed', limits_applied: limits };
            }
          }
        }
      }
    }

    if (input.tool_name === ToolName.DataQuery) {
      const sql = (input.parsed_input as Record<string, unknown>)['sql'];
      if (typeof sql !== 'string') {
        return {
          effect: 'deny',
          reason: 'invalid_sql',
          limits_applied: limits,
        };
      }

      const check = validateReadOnlySql(sql);
      if (!check.ok) {
        return {
          effect: 'deny',
          reason: check.reason,
          limits_applied: limits,
        };
      }
    }

    return {
      effect: 'allow',
      reason: 'policy_allow',
      limits_applied: limits,
    };
  }
}

function mergeLimits(env: Env, parsedInput: unknown) {
  const requestedMaxRows = getOptionalInt(parsedInput, 'max_rows');
  const requestedTimeout = getOptionalInt(parsedInput, 'timeout_ms');

  const max_rows = clamp(
    requestedMaxRows ?? env.MAX_ROWS_DEFAULT,
    1,
    env.MAX_ROWS_HARD_MAX,
  );

  const timeout_ms = clamp(
    requestedTimeout ?? env.TOOL_TIMEOUT_MS_DEFAULT,
    1,
    env.TOOL_TIMEOUT_MS_HARD_MAX,
  );

  return {
    max_rows,
    timeout_ms,
    max_output_bytes: env.MAX_OUTPUT_BYTES,
  };
}

function getOptionalInt(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = (value as Record<string, unknown>)[key];
  return typeof v === 'number' && Number.isInteger(v) ? v : undefined;
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function getDataSource(parsedInput: unknown): 'snowflake' | 'athena' | 'motherduck' | null {
  const v = getString(parsedInput, 'data_source');
  if (v === 'snowflake' || v === 'athena' || v === 'motherduck') return v;
  return null;
}

function getString(parsedInput: unknown, key: string): string | undefined {
  if (!parsedInput || typeof parsedInput !== 'object') return undefined;
  const v = (parsedInput as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : undefined;
}

function isRegistryTool(toolName: string) {
  return toolName.startsWith('registry.');
}

