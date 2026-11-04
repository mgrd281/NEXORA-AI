/**
 * Microsoft identity platform v2.0 (authorization code + PKCE, confidential
 * client): authorization URL (response_mode=query), token requests carrying
 * the scopes, and GET /me (Graph) for the account's object id and address.
 * Microsoft has no per-app token revocation endpoint (revokeSignInSessions
 * would sign the user out everywhere), so disconnecting erases JARVIS's tokens
 * and the user removes the app's consent in their account (revocation 'local_only').
 */
import type { Config, MicrosoftEndpoints } from '../../../config';
import type { OAuthProviderAdapter, ProviderIdentity } from '../oauth-client';
import { providerSignal } from '../signal';

const endpoints = (config: Config): MicrosoftEndpoints => {
  const client = config.oauth.microsoft;
  if (!client) throw new Error('Microsoft is not configured on this server');
  return client.endpoints;
};

export const microsoftOAuth: OAuthProviderAdapter = {
  provider: 'microsoft',
  issuer: (config) => endpoints(config).issuer,
  authorizeUrl(config, p) {
    const url = new URL(endpoints(config).authorize);
    url.search = new URLSearchParams({
      client_id: config.oauth.microsoft!.clientId,
      response_type: 'code',
      redirect_uri: p.redirectUri,
      response_mode: 'query',
      scope: p.scopes.join(' '),
      state: p.state,
      code_challenge: p.codeChallenge,
      code_challenge_method: 'S256',
    }).toString();
    return url.toString();
  },
  tokenUrl: (config) => endpoints(config).token,
  tokenExtras: (scopes) => ({ scope: scopes.join(' ') }),
  async identity(config, accessToken, signal): Promise<ProviderIdentity> {
    const res = await fetch(`${endpoints(config).graph}/me?$select=id,mail,userPrincipalName`, {
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
      signal: providerSignal(signal),
      redirect: 'error',
    });
    if (!res.ok) throw Object.assign(new Error(`/me ${res.status}`), { status: res.status });
    const body = (await res.json()) as {
      id?: unknown;
      mail?: unknown;
      userPrincipalName?: unknown;
    };
    const email =
      typeof body.mail === 'string' && body.mail
        ? body.mail
        : typeof body.userPrincipalName === 'string'
          ? body.userPrincipalName
          : null;
    if (typeof body.id !== 'string' || !email) throw new Error('/me without id/mail');
    return { accountId: body.id, email: email.toLowerCase() };
  },
  revokeUrl: () => null,
};
