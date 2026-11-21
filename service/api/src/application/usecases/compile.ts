import type { RegistryService } from '../../../../registry/application/ports/registry-service.js';
import type { CompileSkillInput, ReviewDeFactoTermInput } from '../../contracts/compile.js';

export class CompileUseCase {
  constructor(private readonly registry: RegistryService) {}

  async compileSkill(input: CompileSkillInput) {
    const result = await this.registry.compileSkillSource({
      source_type: input.source_type,
      content: input.content,
      ...(input.ontology_version ? { ontology_version: input.ontology_version } : {}),
    });

    let draft: unknown = undefined;
    if (input.create_draft) {
      const skillKey = input.skill_key ?? result.compiled.skill_key;
      if (!skillKey) {
        return { ...result, draft_error: 'skill_key is required to create a draft (neither extracted nor provided).' };
      }
      draft = await this.registry.createSkillDraft({
        skill_key: skillKey,
        artifact: {
          content: input.content,
          encoding: 'utf8',
          ...(input.source_type === 'markdown' ? { media_type: 'text/markdown' } : { media_type: 'application/json' }),
          original_path: `compiled/${skillKey.replace(/[^a-zA-Z0-9._-]+/g, '-')}.${input.source_type === 'markdown' ? 'md' : 'json'}`,
        },
        author: input.author,
        ...(result.compiled.display_name ? { display_name: result.compiled.display_name } : {}),
        ...(result.compiled.description ? { description: result.compiled.description } : {}),
        ...(result.compiled.capability_claims.length > 0 ? { capability_claims: result.compiled.capability_claims } : {}),
        ...(input.ontology_version ? { governance: { ontology_version: input.ontology_version } } : {}),
      });
    }
    return { ...result, ...(draft !== undefined ? { draft } : {}) };
  }
}

export class DeFactoTermsUseCase {
  constructor(private readonly registry: RegistryService) {}

  async list(input?: { status?: 'candidate' | 'promoted' | 'rejected' }) {
    return await this.registry.listDeFactoTerms(input);
  }

  async analyze(input?: { ontology_version?: string }) {
    return await this.registry.analyzeDeFactoVocabulary(input);
  }

  async review(input: { term: string } & ReviewDeFactoTermInput) {
    return await this.registry.reviewDeFactoTerm({
      term: input.term,
      action: input.action,
      author: input.author,
      ...(input.source_ontology_version ? { source_ontology_version: input.source_ontology_version } : {}),
      ...(input.target_ontology_version ? { target_ontology_version: input.target_ontology_version } : {}),
      ...(input.target_ontology_format ? { target_ontology_format: input.target_ontology_format } : {}),
    });
  }
}
