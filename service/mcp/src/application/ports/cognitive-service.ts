import type { Principal } from '../../domain/principal/principal.js';

export type CognitiveShapeInput = {
  principal: Principal;
  tool_name: string;
  input_sha256: string;
  result: unknown;
};

export type CognitiveShapeOutput = {
  result: unknown;
  summarized: boolean;
  estimated_tokens: number;
};

/**
 * Cognitive layer port. Estimates the token cost of a tool result and, when it
 * would exceed the configured LLM context budget, returns a cached/summarized
 * form instead of the full payload.
 */
export interface CognitiveService {
  shape(input: CognitiveShapeInput): Promise<CognitiveShapeOutput>;
}
