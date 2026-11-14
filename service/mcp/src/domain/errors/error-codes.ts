export const ErrorCode = {
  ToolNotFound: 'TOOL_NOT_FOUND',
  ValidationError: 'VALIDATION_ERROR',
  AuthUnauthenticated: 'AUTH_UNAUTHENTICATED',
  AuthForbidden: 'AUTH_FORBIDDEN',
  RegistryEntityNotFound: 'REGISTRY_ENTITY_NOT_FOUND',
  RegistryArtifactNotFound: 'REGISTRY_ARTIFACT_NOT_FOUND',
  RegistryArtifactDigestMismatch: 'ARTIFACT_DIGEST_MISMATCH',
  RegistryReadDeniedRevoked: 'REGISTRY_READ_DENIED_REVOKED',
  RegistryReadDeniedUnverified: 'REGISTRY_READ_DENIED_UNVERIFIED',
  SqlNotReadOnly: 'SQL_NOT_READ_ONLY',
  ConnectorTimeout: 'CONNECTOR_TIMEOUT',
  ResultTooLarge: 'RESULT_TOO_LARGE',
  InternalError: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

