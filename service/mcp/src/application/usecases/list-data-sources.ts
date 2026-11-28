import type { Env } from '../../infrastructure/config/env.js';

export type DataSourceMode = 'mock' | 'real';

export type DataSourceReadiness = {
  data_source: 'snowflake' | 'athena' | 'motherduck';
  mode: DataSourceMode;
  /** True when data.* calls against this source can serve right now. */
  ready: boolean;
  /** Env vars that must be set before real mode can serve (never values). */
  missing_config?: string[];
  notes?: string;
};

// Read-only readiness surface for the approved data sources (roadmap
// worksession 39, "data-access golden path"): operators and harnesses can see
// which sources are live and in which mode before issuing data.* calls.
// Reports presence of configuration only — never values.
export class ListDataSourcesUseCase {
  constructor(private readonly env: Env) {}

  execute(): { data_sources: DataSourceReadiness[] } {
    return {
      data_sources: [this.snowflake(), this.athena(), this.motherduck()],
    };
  }

  private snowflake(): DataSourceReadiness {
    if (this.env.SNOWFLAKE_MODE === 'mock') {
      return { data_source: 'snowflake', mode: 'mock', ready: true };
    }
    const missing = [
      ...presentCheck('SNOWFLAKE_ACCOUNT', this.env.SNOWFLAKE_ACCOUNT),
      ...presentCheck('SNOWFLAKE_USERNAME', this.env.SNOWFLAKE_USERNAME),
      ...presentCheck('SNOWFLAKE_PASSWORD', this.env.SNOWFLAKE_PASSWORD),
    ];
    return {
      data_source: 'snowflake',
      mode: 'real',
      ready: missing.length === 0,
      ...(missing.length > 0 ? { missing_config: missing } : {}),
      notes:
        'query path is live; catalog metadata (data.list_tables / data.describe_table) returns empty in real mode until metadata parity lands',
    };
  }

  private athena(): DataSourceReadiness {
    if (this.env.ATHENA_MODE === 'mock') {
      return { data_source: 'athena', mode: 'mock', ready: true };
    }
    const missing = [
      ...presentCheck('ATHENA_WORKGROUP', this.env.ATHENA_WORKGROUP),
      ...presentCheck('ATHENA_OUTPUT_S3', this.env.ATHENA_OUTPUT_S3),
    ];
    return {
      data_source: 'athena',
      mode: 'real',
      ready: missing.length === 0,
      ...(missing.length > 0 ? { missing_config: missing } : {}),
      notes:
        'AWS credentials and region come from the standard AWS environment chain (AWS_REGION, AWS_ACCESS_KEY_ID / AWS_PROFILE, …); catalog metadata returns empty in real mode until metadata parity lands',
    };
  }

  private motherduck(): DataSourceReadiness {
    if (this.env.MOTHERDUCK_MODE === 'mock') {
      return { data_source: 'motherduck', mode: 'mock', ready: true };
    }
    const missing = presentCheck('MOTHERDUCK_TOKEN', this.env.MOTHERDUCK_TOKEN);
    return {
      data_source: 'motherduck',
      mode: 'real',
      ready: missing.length === 0,
      ...(missing.length > 0 ? { missing_config: missing } : {}),
      notes: `database defaults to "my_db" (set MOTHERDUCK_DATABASE to override)`,
    };
  }
}

function presentCheck(name: string, value: string | undefined): string[] {
  return value && value.trim().length > 0 ? [] : [name];
}
