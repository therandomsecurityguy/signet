export type ApiKeyPrincipal = {
  type: 'api_key';
  id: string;
  displayName?: string;
  scopes: string[];
  groups: string[];
  claims: Record<string, unknown>;
  authMethod: 'api_key';
};

export type OktaUserPrincipal = {
  type: 'okta_user';
  id: string;
  email?: string;
  displayName?: string;
  scopes: string[];
  groups: string[];
  claims: Record<string, unknown>;
  authMethod: 'okta_access_token';
};

export type AnonymousPrincipal = {
  type: 'anonymous';
  id: 'anonymous';
  scopes: string[];
  groups: string[];
  claims: Record<string, never>;
  authMethod: 'none';
};

export type Principal = ApiKeyPrincipal | OktaUserPrincipal | AnonymousPrincipal;
