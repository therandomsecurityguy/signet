import type { ZodTypeAny } from 'zod';

import type { ToolName } from './tool-names.js';

export type ToolRiskTier = 'READ_ONLY';

export type ToolDefinition = {
  name: ToolName;
  version: string;
  description: string;
  risk_tier: ToolRiskTier;
  inputSchema: ZodTypeAny;
  outputSchema: ZodTypeAny;
};

