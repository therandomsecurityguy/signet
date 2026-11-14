import type { CognitiveService, CognitiveShapeInput, CognitiveShapeOutput } from '../../application/ports/cognitive-service.js';
import { estimateTokens } from '../../domain/cognitive/token-estimator.js';
import { summarizeCompact } from '../../domain/cognitive/summarizer.js';
import { EphemeralCache } from './ephemeral-cache.js';

export type CognitiveLayerConfig = {
  enabled: boolean;
  budget_tokens: number;
  cache_ttl_ms: number;
  cache_max_entries: number;
};

/**
 * Default cognitive layer. Estimates the token cost of a tool result; when it
 * exceeds the configured LLM context budget, returns a summarized form and
 * caches the summary (ephemeral) for repeated identical requests.
 */
export class DefaultCognitiveService implements CognitiveService {
  private readonly cache: EphemeralCache<unknown>;

  constructor(private readonly config: CognitiveLayerConfig) {
    this.cache = new EphemeralCache<unknown>({
      maxEntries: config.cache_max_entries,
      ttlMs: config.cache_ttl_ms,
    });
  }

  async shape(input: CognitiveShapeInput): Promise<CognitiveShapeOutput> {
    if (!this.config.enabled) {
      return { result: input.result, summarized: false, estimated_tokens: 0 };
    }

    const estimated_tokens = estimateTokens(input.result);
    if (estimated_tokens <= this.config.budget_tokens) {
      return { result: input.result, summarized: false, estimated_tokens };
    }

    const cacheKey = `${input.principal.id}:${input.tool_name}:${input.input_sha256}`;
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) {
      return { result: cached, summarized: true, estimated_tokens };
    }

    const summary = {
      _summarized: true,
      reason: 'context_budget_exceeded',
      estimated_tokens,
      budget_tokens: this.config.budget_tokens,
      summary: summarizeCompact(input.result),
    };
    this.cache.set(cacheKey, summary);
    return { result: summary, summarized: true, estimated_tokens };
  }
}
