import { createHash, randomBytes, randomUUID } from 'node:crypto';

export type OktaDiscoveryDocument = {
  authorization_endpoint: string;
  token_endpoint: string;
};

export async function fetchDiscoveryDocument(input: {
  issuer: string;
  fetchFn?: typeof fetch;
}): Promise<OktaDiscoveryDocument> {
  const res = await (input.fetchFn ?? fetch)(new URL('.well-known/openid-configuration', ensureTrailingSlash(input.issuer)));
  if (!res.ok) {
    throw new Error(`Failed to load Okta discovery document (${res.status})`);
  }
  return (await res.json()) as OktaDiscoveryDocument;
}

export function buildPkceState() {
  const state = randomUUID();
  const verifier = base64Url(randomBytes(32));
  const challenge = sha256Base64Url(verifier);
  return { state, verifier, challenge };
}

export function buildAuthorizeUrl(input: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  scopes: string;
  state: string;
  codeChallenge: string;
}) {
  const url = new URL(input.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('scope', input.scopes);
  url.searchParams.set('state', input.state);
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export async function exchangeCodeForAccessToken(input: {
  tokenEndpoint: string;
  code: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  codeVerifier: string;
  fetchFn?: typeof fetch;
}) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.codeVerifier,
  });

  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/x-www-form-urlencoded',
  };

  if (input.clientSecret) {
    // Confidential client (Okta token_endpoint_auth_method=client_secret_basic):
    // credentials go in the Authorization header, not the body.
    headers.authorization = `Basic ${Buffer.from(`${input.clientId}:${input.clientSecret}`).toString('base64')}`;
  } else {
    body.set('client_id', input.clientId);
  }

  const res = await (input.fetchFn ?? fetch)(input.tokenEndpoint, {
    method: 'POST',
    headers,
    body: body.toString(),
  });

  if (!res.ok) {
    throw new Error(`Failed to exchange Okta authorization code (${res.status})`);
  }

  const payload = (await res.json()) as { access_token?: string };
  if (!payload.access_token) {
    throw new Error('Okta token response missing access_token');
  }
  return payload.access_token;
}

function sha256Base64Url(value: string) {
  return base64Url(createHash('sha256').update(value).digest());
}

function base64Url(buffer: Uint8Array) {
  return Buffer.from(buffer)
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

function ensureTrailingSlash(value: string) {
  return value.endsWith('/') ? value : `${value}/`;
}
