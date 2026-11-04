/**
 * Google OAuth 2.0 / OpenID Connect (web server flow): authorization URL with
 * PKCE S256, offline access (refresh token), incremental authorization
 * (include_granted_scopes), the userinfo endpoint for the account's `sub` and
 * address, and the revocation endpoint (https://oauth2.googleapis.com/revoke).
 */
import type { Config, GoogleEndpoints } from '../../../config';
import type { OAuthProviderAdapter, ProviderIdentity } from '../oauth-client';
import { providerSignal } from '../signal';

const endpoints = (config: Config): GoogleEndpoints => {
  const client = config.oauth.google;
  if (!client) throw new Error('Google is not configured on this server');
  return client.endpoints;
};

export const googleOAuth: OAuthProviderAdapter = {
  provider: 'google',
  issuer: (config) => endpoints(config).issuer,
  authorizeUrl(config, p) {
    const url = new URL(endpoints(config).authorize);
    url.search = new URLSearchParams({
      client_id: config.oauth.google!.clientId,
      redirect_uri: p.redirectUri,
      response_type: 'code',
      scope: p.scopes.join(' '),
      state: p.state,
      code_challenge: p.codeChallenge,
      code_challenge_method: 'S256',
      // A refresh token on every consent (Google sends one only with prompt=consent).
      access_type: 'offline',
      prompt: 'consent',
      ...(p.incremental ? { include_granted_scopes: 'true' } : {}),
    }).toString();
    return url.toString();
  },
  tokenUrl: (config) => endpoints(config).token,
  tokenExtras: () => ({}),
  async identity(config, accessToken, signal): Promise<ProviderIdentity> {
    const res = await fetch(endpoints(config).userinfo, {
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
      signal: providerSignal(signal),
      redirect: 'error',
    });
    if (!res.ok) throw Object.assign(new Error(`userinfo ${res.status}`), { status: res.status });
    const body = (await res.json()) as { sub?: unknown; email?: unknown; email_verified?: unknown };
    if (typeof body.sub !== 'string' || typeof body.email !== 'string')
      throw new Error('userinfo without sub/email');
    if (body.email_verified === false) throw new Error('unverified email');
    return { accountId: body.sub, email: body.email.toLowerCase() };
  },
  revokeUrl: (config) => endpoints(config).revoke,
};
