// Operator tag curation port. The graph adapter delegates to the registry
// core's updateTags (normalization + storage on the logical node).
export interface RegistryTagsPort {
  setTags(input: {
    entity_type: 'SKILL' | 'AGENT';
    logical_key: string;
    tags: string[];
  }): Promise<{ tags: string[] }>;
}
