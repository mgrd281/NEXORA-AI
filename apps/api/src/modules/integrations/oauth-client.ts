/**
 * The OAuth 2.0 client side shared by both providers: the token endpoint
 * (authorization_code with PKCE, refresh_token; RFC 6749 §4.1.3 / §6), and
 * provider descriptors (google/oauth.ts, microsoft/oauth.ts) for what
 * differs. Endpoints come only from Config (fixed hosts; the mock override
 * is refused in production) — never from a response (mix-up defence).
 */
import { OAUTH_SCOPES, type ConnectionCapability } from '@jarvis/contracts';
import type { Config } from '../../config';
import { googleOAuth } from './google/oauth';
import { microsoftOAuth } from './microsoft/oauth';
import { providerSignal } from './signal';
import type { OAuthProvider } from './types';

export interface TokenResponse {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
}

export type TokenOutcome =
  | { kind: 'ok'; tokens: TokenResponse }
  /** The grant (code or refresh token) was refused: invalid_grant (expired / revoked / used). */
  | { kind: 'invalid_grant'; error: string }
  /** Another refusal (client misconfigured, invalid request): definite, not transient. */
  | { kind: 'refused'; status: number; error: string }
  /** No answer / 5xx: nothing is known, retry later. */
  | { kind: 'unavailable'; status: number | null };

export interface ProviderIdentity {
  /** Google `sub` / Microsoft object id. */
  accountId: string;
  email: string;
}

export interface OAuthProviderAdapter {
  provider: OAuthProvider;
  /** RFC 9207 issuer of authorization responses (compared with `iss` when one is sent). */
  issuer(config: Config): string;
  authorizeUrl(
    config: Config,
    p: {
      state: string;
      codeChallenge: string;
      scopes: readonly string[];
      redirectUri: string;
      incremental: boolean;
    },
  ): string;
  tokenUrl(config: Config): string;
  /** Extra form fields of token requests (Microsoft: scope). */
  tokenExtras(scopes: readonly string[]): Record<string, string>;
  identity(config: Config, accessToken: string, signal: AbortSignal): Promise<ProviderIdentity>;
  /** The revocation endpoint, or null when the provider has none per app (Microsoft). */
  revokeUrl(config: Config): string | null;
}

export const OAUTH_ADAPTERS: Record<OAuthProvider, OAuthProviderAdapter> = {
  google: googleOAuth,
  microsoft: microsoftOAuth,
};

export function oauthClient(config: Config, provider: OAuthProvider) {
  return config.oauth[provider];
}

/** Provider scope as compared: Graph scopes without the resource prefix, case-insensitively. */
export function normalizeScope(provider: OAuthProvider, scope: string): string {
  return provider === 'microsoft'
    ? scope.replace(/^https:\/\/graph\.microsoft\.com\//i, '').toLowerCase()
    : scope;
}

/** The scopes an authorization asks for: identity ∪ the capabilities' scopes (deduplicated, ordered). */
export function scopesFor(
  provider: OAuthProvider,
  capabilities: readonly ConnectionCapability[],
): string[] {
  const out: string[] = [...OAUTH_SCOPES[provider].identity];
  for (const c of capabilities) for (const s of OAUTH_SCOPES[provider][c]) out.push(s);
  return [...new Set(out)];
}

/** Capabilities whose scopes were ALL granted (Google's granular consent lets users untick some). */
export function capabilitiesFromScopes(
  provider: OAuthProvider,
  granted: readonly string[],
): ConnectionCapability[] {
  const have = new Set(granted.map((s) => normalizeScope(provider, s)));
  const caps: ConnectionCapability[] = [];
  for (const cap of [
    'mail.read',
    'mail.compose',
    'mail.send',
    'calendar.read',
    'calendar.write',
  ] as const) {
    if (OAUTH_SCOPES[provider][cap].every((s) => have.has(normalizeScope(provider, s))))
      caps.push(cap);
  }
  return caps;
}

export { providerSignal };

/** POST to the token endpoint with the client's credentials (client_secret_post). */
export async function tokenRequest(
  config: Config,
  provider: OAuthProvider,
  form: Record<string, string>,
  signal?: AbortSignal,
): Promise<TokenOutcome> {
  const client = oauthClient(config, provider);
  if (!client) return { kind: 'refused', status: 0, error: 'not_configured' };
  const adapter = OAUTH_ADAPTERS[provider];
  let res: Response;
  try {
    res = await fetch(adapter.tokenUrl(config), {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: new URLSearchParams({
        ...form,
        client_id: client.clientId,
        client_secret: client.clientSecret,
      }).toString(),
      signal: providerSignal(signal),
      redirect: 'error',
    });
  } catch {
    return { kind: 'unavailable', status: null };
  }
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  if (res.ok && typeof body.access_token === 'string')
    return { kind: 'ok', tokens: body as unknown as TokenResponse };
  if (res.status >= 500 || res.status === 429) return { kind: 'unavailable', status: res.status };
  const error = typeof body.error === 'string' ? body.error : `http_${res.status}`;
  if (error === 'invalid_grant') return { kind: 'invalid_grant', error };
  return { kind: 'refused', status: res.status, error };
}

/** The scopes of a token response (absent = as requested, RFC 6749 §5.1). */
export function grantedScopes(tokens: TokenResponse, requested: readonly string[]): string[] {
  return typeof tokens.scope === 'string' && tokens.scope.trim()
    ? [...new Set(tokens.scope.split(/\s+/).filter(Boolean))]
    : [...requested];
}

export function expiresAtOf(tokens: TokenResponse, now = Date.now()): Date {
  const seconds =
    typeof tokens.expires_in === 'number' && tokens.expires_in > 0 ? tokens.expires_in : 3600;
  return new Date(now + seconds * 1000);
}
