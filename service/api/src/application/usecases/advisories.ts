import type { RegistryService } from '../../../../registry/application/ports/registry-service.js';
import type { CreateAdvisoryInput } from '../../contracts/publication/advisories.js';

export class AdvisoriesUseCase {
  constructor(private readonly registry: RegistryService) {}

  async ingest(input: CreateAdvisoryInput) {
    const affected = input.advisory.affected;
    return await this.registry.ingestAdvisory({
      ...(input.mode ? { mode: input.mode } : {}),
      advisory: {
        advisory_id: input.advisory.advisory_id,
        source: input.advisory.source,
        severity: input.advisory.severity,
        summary: input.advisory.summary,
        ...(input.advisory.published_at ? { published_at: input.advisory.published_at } : {}),
        ...(input.advisory.references ? { references: input.advisory.references } : {}),
        affected: {
          ...(affected.artifact_sha256 ? { artifact_sha256: affected.artifact_sha256 } : {}),
          ...(affected.skills
            ? {
                skills: affected.skills.map((entry) => ({
                  skill_key: entry.skill_key,
                  ...(entry.version ? { version: entry.version } : {}),
                })),
              }
            : {}),
          ...(affected.agents
            ? {
                agents: affected.agents.map((entry) => ({
                  agent_key: entry.agent_key,
                  ...(entry.version ? { version: entry.version } : {}),
                })),
              }
            : {}),
        },
      },
      signer: input.signer,
      key_ref: input.key_ref,
      algorithm: input.algorithm,
      signature: input.signature,
    });
  }

  async get(input: { advisory_id: string }) {
    return await this.registry.getAdvisory(input);
  }

  async list(input: { limit?: number; offset?: number }) {
    return await this.registry.listAdvisories(input);
  }
}
