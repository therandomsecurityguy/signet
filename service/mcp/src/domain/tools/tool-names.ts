export const ToolName = {
  DataQuery: 'data.query',
  DataListTables: 'data.list_tables',
  DataDescribeTable: 'data.describe_table',

RegistryListAgents: 'registry.list_agents',
  RegistryGetAgent: 'registry.get_agent',
  RegistryListSkills: 'registry.list_skills',
  RegistryGetSkill: 'registry.get_skill',
  RegistryGetArtifact: 'registry.get_artifact',
  RegistryGetProvenance: 'registry.get_provenance',
  RegistryVerifyPublication: 'registry.verify_publication',
  RegistryGetAttestations: 'registry.get_attestations',
  RegistrySearch: 'registry.search',
} as const;

export type ToolName = (typeof ToolName)[keyof typeof ToolName];

