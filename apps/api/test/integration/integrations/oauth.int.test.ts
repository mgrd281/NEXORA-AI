/**
 * OAuth 2.0 connections against the mock providers (docs/adr/0016): PKCE S256
 * verified by the provider, state bound to the session, single use and
 * expiring, exact redirect URIs, iss, least-privilege and incremental scopes,
 * partial grants, denial, account mismatch, sealed tokens.
 */
import { OAUTH_SCOPES } from '@jarvis/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pkceChallenge } from '../../../../../tools/mock-providers/index.mjs';
import { withContext } from '../../../src/db/pool';
import { AppError } from '../../../src/lib/errors';
import { integrations } from '../../../src/modules/integrations';
import { openTokens, oauthAad } from '../../../src/modules/integrations/tokens';
import { asOwner, auditActions } from '../agent/harness';
import {
  REDIRECT_URI,
  callbackBody,
  connect,
  consent,
  createIntegrationsHarness,
  newUserWithMailbox,
  sessionOf,
  type IntegrationsHarness,
} from './harness';

let h: IntegrationsHarness;
beforeAll(async () => {
  h = await createIntegrationsHarness();
});
afterAll(() => h.close());

async function reason(
  p: Promise<unknown>,
): Promise<{ code: string; reason: unknown; status: number }> {
  try {
    await p;
  } catch (e) {
    if (e instanceof AppError) return { code: e.code, reason: e.details?.reason, status: e.status };
    throw e;
  }
  throw new Error('expected an AppError');
}

async function connectionRow(user: { tenantId: string; userId: string }, provider: string) {
  return withContext(h.db, user, (trx) =>
    trx
      .selectFrom('connections')
      .selectAll()
      .where('provider', '=', provider as never)
      .where('status', '<>', 'revoked')
      .executeTakeFirstOrThrow(),
  );
}

describe('OAuth connect (Google)', () => {
  it('authorization code + PKCE: the provider verifies the verifier; least-privilege scopes; tokens sealed', async () => {
    const user = await newUserWithMailbox(h);
    const ctx = await sessionOf(h.db, user);
    const start = await integrations.startOAuth(h, ctx, {
      provider: 'google',
      capabilities: ['mail.read', 'calendar.read'],
      redirectUri: REDIRECT_URI,
      returnTo: '/connections',
    });
    const url = new URL(start.authorizationUrl);
    expect(url.origin).toBe(h.google.url);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(url.searchParams.get('scope')!.split(' ').sort()).toEqual(
      [
        ...OAUTH_SCOPES.google.identity,
        ...OAUTH_SCOPES.google['mail.read'],
        ...OAUTH_SCOPES.google['calendar.read'],
      ].sort(),
    );
    // The state is stored only as a hash, bound to this session.
    const [state] = await asOwner<{
      session_id: string;
      state_hash: Buffer;
      capabilities: string[];
    }>('SELECT session_id, state_hash, capabilities FROM oauth_states WHERE user_id = $1', [
      user.userId,
    ]);
    expect(state!.session_id).toBe(ctx.sessionId);
    expect(state!.state_hash.toString('utf8')).not.toContain(url.searchParams.get('state')!);

    const params = await consent(start.authorizationUrl);
    expect(params.get('iss')).toBe(h.google.issuer);
    const tokenCallsBefore = h.google.requests.filter((r) => r.path === '/token').length;
    const result = await integrations.completeOAuth(h, ctx, callbackBody(params));
    expect(result.returnTo).toBe('/connections');
    expect(result.resumableTaskIds).toEqual([]);
    expect(result.connection).toMatchObject({
      provider: 'google',
      status: 'active',
      accountIdentifier: user.mailbox,
      capabilities: ['mail.read', 'calendar.read'],
      statusReason: null,
    });
    // The code exchange carried the verifier whose S256 matches the challenge (the mock checked it).
    const exchange = h.google.requests
      .filter((r) => r.path === '/token')
      .slice(tokenCallsBefore)[0]!;
    const form = exchange.body as Record<string, string>;
    expect(form.grant_type).toBe('authorization_code');
    expect(pkceChallenge(form.code_verifier!)).toBe(url.searchParams.get('code_challenge'));
    expect(form.redirect_uri).toBe(REDIRECT_URI);
    expect(exchange.status).toBe(200);

    // Tokens: one envelope, AAD bound to user + provider + connection id; never in plain columns.
    const row = await connectionRow(user, 'google');
    expect(row.secret_ciphertext).not.toBeNull();
    const tokens = openTokens(h.secrets, row);
    expect(tokens.refreshToken).toMatch(/^rt_/);
    expect(row.secret_ciphertext!.toString('latin1')).not.toContain(tokens.accessToken);
    expect(() =>
      h.secrets.open(row.secret_ciphertext!, oauthAad(user.userId, 'microsoft', row.id)),
    ).toThrow();
    expect(row.provider_account_id).toMatch(/^\d+$/);
    expect(row.token_expires_at!.getTime()).toBeGreaterThan(Date.now() + 3_000_000);
    const actions = await auditActions(user.userId);
    expect(actions).toEqual(
      expect.arrayContaining(['connection.oauth_started', 'connection.connected']),
    );
  });

  it('a wrong PKCE verifier is refused by the provider (the mock enforces S256)', async () => {
    const user = await newUserWithMailbox(h);
    h.google.setLoginAccount(user.mailbox);
    const ctx = await sessionOf(h.db, user);
    const start = await integrations.startOAuth(h, ctx, {
      provider: 'google',
      capabilities: ['mail.read'],
      redirectUri: REDIRECT_URI,
    });
    const params = await consent(start.authorizationUrl);
    const res = await fetch(`${h.google.url}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: params.get('code')!,
        redirect_uri: REDIRECT_URI,
        client_id: h.config.oauth.google!.clientId,
        client_secret: h.config.oauth.google!.clientSecret,
        code_verifier: 'not-the-verifier-not-the-verifier-not-the-verifier',
      }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_grant');
    // The code was single use at the provider: our callback now fails the exchange.
    expect(await reason(integrations.completeOAuth(h, ctx, callbackBody(params)))).toMatchObject({
      code: 'CONNECTION_FAILED',
      reason: 'OAUTH_EXCHANGE_FAILED',
      status: 422,
    });
  });

  it('a state is single use, bound to the session, and expires', async () => {
    const user = await newUserWithMailbox(h);
    h.google.setLoginAccount(user.mailbox);
    const ctx = await sessionOf(h.db, user);
    const start = await integrations.startOAuth(h, ctx, {
      provider: 'google',
      capabilities: ['mail.read'],
      redirectUri: REDIRECT_URI,
    });
    const params = await consent(start.authorizationUrl);
    // Another session of the same user cannot complete it.
    const other = await sessionOf(h.db, user);
    expect(await reason(integrations.completeOAuth(h, other, callbackBody(params)))).toMatchObject({
      reason: 'OAUTH_STATE_INVALID',
      status: 400,
    });
    await integrations.completeOAuth(h, ctx, callbackBody(params));
    // Replay of the same callback.
    expect(await reason(integrations.completeOAuth(h, ctx, callbackBody(params)))).toMatchObject({
      reason: 'OAUTH_STATE_INVALID',
    });
    // An unknown state.
    expect(
      await reason(integrations.completeOAuth(h, ctx, { state: 'x'.repeat(43), code: 'whatever' })),
    ).toMatchObject({ reason: 'OAUTH_STATE_INVALID' });

    // Expired: older than OAUTH_LIMITS.stateTtlMinutes.
    const late = await integrations.startOAuth(h, ctx, {
      provider: 'google',
      capabilities: ['calendar.read'],
      redirectUri: REDIRECT_URI,
    });
    const lateParams = await consent(late.authorizationUrl);
    await asOwner(
      "UPDATE oauth_states SET created_at = now() - interval '11 minutes', expires_at = now() - interval '1 minute' WHERE user_id = $1 AND consumed_at IS NULL",
      [user.userId],
    );
    expect(
      await reason(integrations.completeOAuth(h, ctx, callbackBody(lateParams))),
    ).toMatchObject({
      reason: 'OAUTH_STATE_EXPIRED',
    });
    // ...and it was consumed: a second try is invalid, not expired.
    expect(
      await reason(integrations.completeOAuth(h, ctx, callbackBody(lateParams))),
    ).toMatchObject({
      reason: 'OAUTH_STATE_INVALID',
    });
  });

  it('refuses an issuer that is not the provider’s (mix-up), a foreign redirect URI, too many pending sign-ins', async () => {
    const user = await newUserWithMailbox(h);
    h.google.setLoginAccount(user.mailbox);
    const ctx = await sessionOf(h.db, user);
    const start = await integrations.startOAuth(h, ctx, {
      provider: 'google',
      capabilities: ['mail.read'],
      redirectUri: REDIRECT_URI,
    });
    const params = await consent(start.authorizationUrl);
    expect(
      await reason(
        integrations.completeOAuth(h, ctx, {
          ...callbackBody(params),
          iss: 'https://evil.example',
        }),
      ),
    ).toMatchObject({ reason: 'OAUTH_STATE_INVALID' });

    expect(
      await reason(
        integrations.startOAuth(h, ctx, {
          provider: 'google',
          capabilities: ['mail.read'],
          redirectUri: 'http://localhost:3000/connections/callback/extra',
        }),
      ),
    ).toMatchObject({ reason: 'REDIRECT_URI_NOT_ALLOWED', status: 400 });

    for (let i = 0; i < 5; i++)
      await integrations.startOAuth(h, ctx, {
        provider: 'microsoft',
        capabilities: ['mail.read'],
        redirectUri: REDIRECT_URI,
      });
    expect(
      await reason(
        integrations.startOAuth(h, ctx, {
          provider: 'microsoft',
          capabilities: ['mail.read'],
          redirectUri: REDIRECT_URI,
        }),
      ),
    ).toMatchObject({ code: 'RATE_LIMITED', reason: 'OAUTH_PENDING_LIMIT', status: 429 });
  });

  it('consent declined → OAUTH_DENIED; nothing granted → OAUTH_SCOPE_NOT_GRANTED; partial grant → only those capabilities', async () => {
    const user = await newUserWithMailbox(h);
    h.google.consent.deny = true;
    try {
      const denied = connect(h, user, 'google', ['mail.read']);
      expect(await reason(denied)).toMatchObject({ reason: 'OAUTH_DENIED', status: 400 });
    } finally {
      h.google.consent.deny = false;
    }
    h.google.consent.grantOnly = [];
    try {
      expect(await reason(connect(h, user, 'google', ['mail.read']))).toMatchObject({
        reason: 'OAUTH_SCOPE_NOT_GRANTED',
      });
      // Calendar read needs BOTH events.readonly and freebusy: one of them is not enough.
      h.google.consent.grantOnly = [
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/calendar.events.readonly',
      ];
      const partial = await connect(h, user, 'google', ['mail.read', 'calendar.read']);
      expect(partial.connection.capabilities).toEqual(['mail.read']);
    } finally {
      h.google.consent.grantOnly = null;
    }
  });

  it('adds a capability incrementally (only the new scopes, include_granted_scopes) and keeps the account', async () => {
    const user = await newUserWithMailbox(h);
    const first = await connect(h, user, 'google', ['mail.read']);
    const ctx = await sessionOf(h.db, user);
    h.google.setLoginAccount(user.mailbox);
    const start = await integrations.startOAuth(h, ctx, {
      provider: 'google',
      capabilities: ['mail.send'],
      redirectUri: REDIRECT_URI,
      connectionId: first.connection.id,
    });
    const url = new URL(start.authorizationUrl);
    expect(url.searchParams.get('include_granted_scopes')).toBe('true');
    expect(url.searchParams.get('scope')!.split(' ').sort()).toEqual(
      [...OAUTH_SCOPES.google.identity, ...OAUTH_SCOPES.google['mail.send']].sort(),
    );
    const done = await integrations.completeOAuth(
      h,
      ctx,
      callbackBody(await consent(start.authorizationUrl)),
    );
    expect(done.connection.id).toBe(first.connection.id);
    expect(done.connection.capabilities).toEqual(['mail.read', 'mail.send']);

    // Reconnecting with a different Google account is refused.
    const intruder = `${user.userId.slice(0, 6)}-other@mail.test`;
    h.google.addAccount({ email: intruder });
    h.google.setLoginAccount(intruder);
    const again = await integrations.startOAuth(h, ctx, {
      provider: 'google',
      capabilities: ['calendar.read'],
      redirectUri: REDIRECT_URI,
      connectionId: first.connection.id,
    });
    expect(
      await reason(
        integrations.completeOAuth(h, ctx, callbackBody(await consent(again.authorizationUrl))),
      ),
    ).toMatchObject({ code: 'CONFLICT', reason: 'OAUTH_ACCOUNT_MISMATCH', status: 409 });
    expect((await connectionRow(user, 'google')).account_identifier).toBe(user.mailbox);
  });

  it('a provider without client credentials is "not configured on this server"', async () => {
    const user = await newUserWithMailbox(h);
    const ctx = await sessionOf(h.db, user);
    const bare = { ...h, config: { ...h.config, oauth: { google: null, microsoft: null } } };
    expect(
      await reason(
        integrations.startOAuth(bare, ctx, {
          provider: 'google',
          capabilities: ['mail.read'],
          redirectUri: REDIRECT_URI,
        }),
      ),
    ).toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      reason: 'PROVIDER_NOT_CONFIGURED',
      status: 503,
    });
    expect(integrations.providers(bare.config).find((p) => p.provider === 'google')).toMatchObject({
      configured: false,
      revocation: 'provider',
    });
    expect(integrations.providers(h.config).find((p) => p.provider === 'microsoft')).toMatchObject({
      configured: true,
      kind: 'oauth',
      revocation: 'local_only',
    });
  });
});

describe('OAuth connect (Microsoft)', () => {
  it('normalises Graph scopes (short names, any case) into capabilities; response_mode=query', async () => {
    const user = await newUserWithMailbox(h);
    const ctx = await sessionOf(h.db, user);
    h.microsoft.setLoginAccount(user.mailbox);
    const start = await integrations.startOAuth(h, ctx, {
      provider: 'microsoft',
      capabilities: ['mail.read', 'mail.send', 'calendar.write'],
      redirectUri: REDIRECT_URI,
    });
    const url = new URL(start.authorizationUrl);
    expect(url.pathname).toBe('/common/oauth2/v2.0/authorize');
    expect(url.searchParams.get('response_mode')).toBe('query');
    expect(url.searchParams.get('scope')).toContain('offline_access');
    expect(url.searchParams.get('scope')).not.toContain('.default');
    const done = await integrations.completeOAuth(
      h,
      ctx,
      callbackBody(await consent(start.authorizationUrl)),
    );
    expect(done.connection.capabilities).toEqual(['mail.read', 'mail.send', 'calendar.write']);
    expect(done.connection.scopes).toContain('Mail.Read');
    const row = await connectionRow(user, 'microsoft');
    expect(row.provider_account_id).toMatch(/^00000000-/);
    expect(openTokens(h.secrets, row).refreshToken).toMatch(/^rt_/);
  });
});
