/**
 * Phase C connections over HTTP (docs/architecture/phase-c.md §3.1, §3.8):
 * providers, OAuth start / callback against the mock Google and Microsoft
 * providers (session-bound state, single use, expiry, redirect allow-list,
 * iss, error mapping, rate limits, no token ever in a response), expired
 * connections and reconnecting (scenario 9), and disconnecting — which
 * revokes the grant at Google through the revocation outbox.
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OAUTH_LIMITS, OAUTH_SCOPES, type Connection } from '@jarvis/contracts';
import { withContext } from '../../../src/db/pool';
import { drainRevocations } from '../../../src/modules/integrations/revocation';
import {
  addMailbox,
  callbackBody,
  connectOAuth,
  consent,
  createOAuthHarness,
  REDIRECT_URI,
  seedWatch,
  startOAuth,
  type OAuthHarness,
} from './phase-c-support';
import {
  createHarness,
  login,
  loginWeb,
  newClient,
  ownerQuery,
  seedConnection,
  WEB_ORIGIN,
  type Client,
} from './support';

let h: OAuthHarness;
beforeAll(async () => {
  h = await createOAuthHarness();
});
afterAll(() => h.close());
beforeEach(() => {
  for (const m of [h.google, h.microsoft]) {
    m.consent.deny = false;
    m.consent.grantOnly = null;
    m.clearFailures();
  }
});

const reasonOf = (res: { json: <T>() => T }) =>
  res.json<{ error: { code: string; details?: { reason?: string } } }>().error;

/** Every token the mock ever issued (access and refresh). */
const issuedTokens = () => [
  ...h.google.oauth.accessTokens.keys(),
  ...h.google.oauth.refreshTokens.keys(),
  ...h.microsoft.oauth.accessTokens.keys(),
  ...h.microsoft.oauth.refreshTokens.keys(),
];

describe('GET /v1/connections/providers', () => {
  it('lists Google and Microsoft with their exact scopes and revocation behaviour', async () => {
    const c = await newClient(h);
    const res = await c.request('GET', '/v1/connections/providers');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    const items = res.json<{
      items: {
        provider: string;
        kind: string;
        configured: boolean;
        capabilities: { capability: string; scopes: string[] }[];
        identityScopes: string[];
        revocation: string | null;
      }[];
    }>().items;
    const google = items.find((p) => p.provider === 'google')!;
    const microsoft = items.find((p) => p.provider === 'microsoft')!;
    expect(google).toMatchObject({ kind: 'oauth', configured: true, revocation: 'provider' });
    expect(microsoft).toMatchObject({ kind: 'oauth', configured: true, revocation: 'local_only' });
    expect(google.identityScopes).toEqual([...OAUTH_SCOPES.google.identity]);
    expect(google.capabilities.find((x) => x.capability === 'mail.read')!.scopes).toEqual([
      ...OAUTH_SCOPES.google['mail.read'],
    ]);
    expect(items.find((p) => p.provider === 'smtp')).toMatchObject({
      kind: 'smtp',
      revocation: null,
    });
    // No client id or secret, no endpoint override leaks into the listing.
    for (const needle of ['jarvis-http-test', h.google.url, h.microsoft.url])
      expect(res.body).not.toContain(needle);
  });

  it('reports a provider without a client as not configured, and refuses to start it', async () => {
    const bare = await createHarness();
    try {
      const c = await newClient(bare);
      const items = (await c.request('GET', '/v1/connections/providers')).json<{
        items: { provider: string; configured: boolean }[];
      }>().items;
      expect(items.find((p) => p.provider === 'google')!.configured).toBe(false);
      expect(items.find((p) => p.provider === 'microsoft')!.configured).toBe(false);
      const res = await c.request('POST', '/v1/connections/oauth/start', {
        provider: 'google',
        capabilities: ['calendar.read'],
        redirectUri: 'http://localhost:3000/connections/callback',
      });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({
        error: {
          code: 'SERVICE_UNAVAILABLE',
          details: { reason: 'PROVIDER_NOT_CONFIGURED', provider: 'google' },
        },
      });
    } finally {
      await bare.close();
    }
  });
});

describe('POST /v1/connections/oauth/start', () => {
  it('returns the provider URL with PKCE S256, a state and exactly the requested least-privilege scopes', async () => {
    const c = await newClient(h);
    const res = await c.request('POST', '/v1/connections/oauth/start', {
      provider: 'google',
      capabilities: ['calendar.read'],
      redirectUri: REDIRECT_URI,
      returnTo: '/connections',
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json<{ authorizationUrl: string; expiresAt: string }>();
    const url = new URL(body.authorizationUrl);
    expect(url.origin).toBe(h.google.url);
    const q = url.searchParams;
    expect(q.get('response_type')).toBe('code');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(q.get('state')!.length).toBeGreaterThanOrEqual(32);
    expect(q.get('scope')!.split(' ').sort()).toEqual(
      [...OAUTH_SCOPES.google.identity, ...OAUTH_SCOPES.google['calendar.read']].sort(),
    );
    const ttl = new Date(body.expiresAt).getTime() - Date.now();
    expect(ttl).toBeGreaterThan((OAUTH_LIMITS.stateTtlMinutes - 1) * 60_000);
    expect(ttl).toBeLessThanOrEqual(OAUTH_LIMITS.stateTtlMinutes * 60_000);

    // Stored server-side, bound to this session: only a hash of the state, the verifier sealed.
    const [row] = await withContext(h.db, c.user, (trx) =>
      trx.selectFrom('oauth_states').selectAll().execute(),
    );
    expect(row!.state_hash.equals(createHash('sha256').update(q.get('state')!).digest())).toBe(
      true,
    );
    expect(row!.session_id).toBeTruthy();
    // The verifier is sealed (AAD bound to the user and the state row) and matches the challenge.
    const verifier = h.secrets.open(
      row!.code_verifier_ciphertext,
      `oauth-state:${c.user.userId}:${row!.id}`,
    );
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(q.get('code_challenge'));
    expect(row!.code_verifier_ciphertext.includes(Buffer.from(verifier))).toBe(false);
    expect(row!.return_to).toBe('/connections');
    expect(row!.redirect_uri).toBe(REDIRECT_URI);
  });

  it('accepts only an exactly allowed redirect URI', async () => {
    const c = await newClient(h);
    for (const redirectUri of [
      'http://localhost:3000/connections/callback/',
      'http://localhost:3000/connections/callback?next=/x',
      'http://localhost:3000/connections/callback#x',
      'http://localhost:3001/connections/callback',
      'http://127.0.0.1:3000/connections/callback',
      'https://localhost:3000/connections/callback',
      'http://evil.example/connections/callback',
    ]) {
      const res = await c.request('POST', '/v1/connections/oauth/start', {
        provider: 'google',
        capabilities: ['mail.read'],
        redirectUri,
      });
      expect(res.statusCode, redirectUri).toBe(400);
      expect(reasonOf(res)).toMatchObject({
        code: 'VALIDATION_FAILED',
        details: { reason: 'REDIRECT_URI_NOT_ALLOWED' },
      });
    }
    const none = await withContext(h.db, c.user, (trx) =>
      trx.selectFrom('oauth_states').select('id').execute(),
    );
    expect(none).toHaveLength(0);
  });

  it('refuses a returnTo that is not a path of the app (open redirect)', async () => {
    const c = await newClient(h);
    for (const returnTo of ['//evil.example', 'https://evil.example/x', '/\\evil.example', 'x']) {
      const res = await c.request('POST', '/v1/connections/oauth/start', {
        provider: 'google',
        capabilities: ['mail.read'],
        redirectUri: REDIRECT_URI,
        returnTo,
      });
      expect(res.statusCode, returnTo).toBe(400);
      expect(reasonOf(res).code).toBe('VALIDATION_FAILED');
    }
  });

  it('refuses another user’s connection (404) and a connection that does not use OAuth (400)', async () => {
    const alice = await newClient(h);
    const bob = await newClient(h);
    const mailbox = addMailbox(h, alice);
    const { connection } = await connectOAuth(h, alice, 'google', ['mail.read'], { mailbox });
    const res = await bob.request('POST', '/v1/connections/oauth/start', {
      provider: 'google',
      capabilities: ['mail.send'],
      redirectUri: REDIRECT_URI,
      connectionId: connection.id,
    });
    expect(res.statusCode).toBe(404);
    // Same id, wrong provider: not found either (no cross-provider reuse).
    const wrong = await alice.request('POST', '/v1/connections/oauth/start', {
      provider: 'microsoft',
      capabilities: ['mail.read'],
      redirectUri: REDIRECT_URI,
      connectionId: connection.id,
    });
    expect(wrong.statusCode).toBe(404);
    const smtpId = await seedConnection(h.db, alice.user, 'web');
    const notOAuth = await alice.request('POST', '/v1/connections/oauth/start', {
      provider: 'google',
      capabilities: ['mail.read'],
      redirectUri: REDIRECT_URI,
      connectionId: smtpId,
    });
    expect(notOAuth.statusCode).toBe(400);
    expect(reasonOf(notOAuth).details?.reason).toBe('CONNECTION_NOT_OAUTH');
  });

  it(`allows at most ${OAUTH_LIMITS.maxPendingStates} unfinished authorizations`, async () => {
    const c = await newClient(h);
    for (let i = 0; i < OAUTH_LIMITS.maxPendingStates; i++)
      await startOAuth(c, 'microsoft', ['calendar.read']);
    const res = await c.request('POST', '/v1/connections/oauth/start', {
      provider: 'microsoft',
      capabilities: ['calendar.read'],
      redirectUri: REDIRECT_URI,
    });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({
      error: {
        code: 'RATE_LIMITED',
        details: { reason: 'OAUTH_PENDING_LIMIT', max: OAUTH_LIMITS.maxPendingStates },
      },
    });
  });

  it('is rate limited per user (10 per minute)', async () => {
    const c = await newClient(h);
    const body = {
      provider: 'google',
      capabilities: ['mail.read'],
      redirectUri: REDIRECT_URI,
      connectionId: randomUUID(),
    };
    for (let i = 0; i < 10; i++)
      expect((await c.request('POST', '/v1/connections/oauth/start', body)).statusCode).toBe(404);
    const limited = await c.request('POST', '/v1/connections/oauth/start', body);
    expect(limited.statusCode).toBe(429);
    expect(reasonOf(limited).code).toBe('RATE_LIMITED');
    // Another user is not affected.
    const other = await newClient(h);
    expect((await other.request('POST', '/v1/connections/oauth/start', body)).statusCode).toBe(404);
  });

  it('checks the Origin of cookie-authenticated starts (CSRF)', async () => {
    const c = await newClient(h);
    const cookie = await loginWeb(h.app, c.user);
    const payload = { provider: 'google', capabilities: ['mail.read'], redirectUri: REDIRECT_URI };
    const forged = await h.app.inject({
      method: 'POST',
      url: '/v1/connections/oauth/start',
      cookies: { jarvis_session: cookie },
      headers: { origin: 'http://evil.example' },
      payload,
    });
    expect(forged.statusCode).toBe(403);
    const ok = await h.app.inject({
      method: 'POST',
      url: '/v1/connections/oauth/start',
      cookies: { jarvis_session: cookie },
      headers: { origin: WEB_ORIGIN },
      payload,
    });
    expect(ok.statusCode).toBe(200);
  });
});

describe('POST /v1/connections/oauth/callback', () => {
  it('connects a Google account: capabilities, granted scopes, no token or account id in the response', async () => {
    const c = await newClient(h);
    const mailbox = addMailbox(h, c);
    h.google.setLoginAccount(mailbox);
    const start = await startOAuth(c, 'google', ['mail.read', 'calendar.read'], {
      returnTo: '/connections',
    });
    const params = await consent(start.authorizationUrl);
    const res = await c.request('POST', '/v1/connections/oauth/callback', callbackBody(params));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const result = res.json<{
      connection: Connection;
      returnTo: string | null;
      resumableTaskIds: string[];
    }>();
    expect(result.returnTo).toBe('/connections');
    expect(result.resumableTaskIds).toEqual([]);
    expect(result.connection).toMatchObject({
      provider: 'google',
      accountIdentifier: mailbox,
      status: 'active',
      statusReason: null,
      capabilities: ['mail.read', 'calendar.read'],
    });
    expect(result.connection.scopes).toEqual(
      expect.arrayContaining([
        ...OAUTH_SCOPES.google['mail.read'],
        ...OAUTH_SCOPES.google['calendar.read'],
      ]),
    );
    const row = await withContext(h.db, c.user, (trx) =>
      trx
        .selectFrom('connections')
        .select(['provider_account_id', 'secret_ciphertext'])
        .where('id', '=', result.connection.id)
        .executeTakeFirstOrThrow(),
    );
    for (const needle of [
      ...issuedTokens(),
      row.provider_account_id!,
      row.secret_ciphertext!.toString('base64'),
      params.get('code')!,
      params.get('state')!,
      'jarvis-http-test-secret',
    ])
      expect(res.body).not.toContain(needle);
    expect(res.body).not.toMatch(/access_?token|refresh_?token|verifier|providerAccountId/i);

    // Listed like every connection, with the Phase C fields.
    const list = (await c.request('GET', '/v1/connections')).json<{ items: Connection[] }>();
    expect(list.items).toEqual([result.connection]);

    // The audit trail names the provider and capabilities, never a token.
    const audits = await ownerQuery<{ action: string; metadata: unknown }>(
      `select action, metadata from audit_events where tenant_id = $1 order by id`,
      [c.user.tenantId],
    );
    expect(audits.map((a) => a.action)).toEqual(
      expect.arrayContaining(['connection.oauth_started', 'connection.connected']),
    );
    const auditText = JSON.stringify(audits);
    for (const needle of [...issuedTokens(), params.get('code')!, params.get('state')!])
      expect(auditText).not.toContain(needle);
  });

  it('connects a Microsoft account the same way', async () => {
    const c = await newClient(h);
    const mailbox = addMailbox(h, c);
    const result = await connectOAuth(h, c, 'microsoft', ['calendar.read', 'calendar.write'], {
      mailbox,
    });
    expect(result.connection).toMatchObject({
      provider: 'microsoft',
      accountIdentifier: mailbox,
      status: 'active',
      capabilities: ['calendar.read', 'calendar.write'],
    });
  });

  it('refuses a state started by another session or another user (login CSRF), without using it up', async () => {
    const alice = await newClient(h);
    const mailbox = addMailbox(h, alice);
    h.google.setLoginAccount(mailbox);
    const start = await startOAuth(alice, 'google', ['mail.read']);
    const body = callbackBody(await consent(start.authorizationUrl));

    // The same user, signed in on another device (another session).
    const otherSession = await login(h.app, alice.user);
    const fromOtherSession = await h.app.inject({
      method: 'POST',
      url: '/v1/connections/oauth/callback',
      headers: { authorization: `Bearer ${otherSession}` },
      payload: body,
    });
    expect(fromOtherSession.statusCode).toBe(400);
    expect(reasonOf(fromOtherSession).details?.reason).toBe('OAUTH_STATE_INVALID');

    // Someone else (an attacker forwarding the victim's redirect, or the reverse).
    const mallory = await newClient(h);
    const fromMallory = await mallory.request('POST', '/v1/connections/oauth/callback', body);
    expect(fromMallory.statusCode).toBe(400);
    expect(reasonOf(fromMallory).details?.reason).toBe('OAUTH_STATE_INVALID');
    const malloryConnections = await withContext(h.db, mallory.user, (trx) =>
      trx.selectFrom('connections').select('id').execute(),
    );
    expect(malloryConnections).toHaveLength(0);

    // The session that started it still can, exactly once.
    const ok = await alice.request('POST', '/v1/connections/oauth/callback', body);
    expect(ok.statusCode, ok.body).toBe(200);
    const replay = await alice.request('POST', '/v1/connections/oauth/callback', body);
    expect(replay.statusCode).toBe(400);
    expect(reasonOf(replay).details?.reason).toBe('OAUTH_STATE_INVALID');
  });

  it('refuses an unknown state and an issuer that is not the provider’s (mix-up)', async () => {
    const c = await newClient(h);
    const unknown = await c.request('POST', '/v1/connections/oauth/callback', {
      state: 'x'.repeat(43),
      code: 'abc',
    });
    expect(unknown.statusCode).toBe(400);
    expect(reasonOf(unknown).details?.reason).toBe('OAUTH_STATE_INVALID');

    const mailbox = addMailbox(h, c);
    h.google.setLoginAccount(mailbox);
    const start = await startOAuth(c, 'google', ['mail.read']);
    const body = callbackBody(await consent(start.authorizationUrl));
    const mixUp = await c.request('POST', '/v1/connections/oauth/callback', {
      ...body,
      iss: h.microsoft.issuer,
    });
    expect(mixUp.statusCode).toBe(400);
    expect(reasonOf(mixUp).details?.reason).toBe('OAUTH_STATE_INVALID');
  });

  it('refuses an expired authorization', async () => {
    const c = await newClient(h);
    const mailbox = addMailbox(h, c);
    h.google.setLoginAccount(mailbox);
    const start = await startOAuth(c, 'google', ['mail.read']);
    const body = callbackBody(await consent(start.authorizationUrl));
    await withContext(h.db, c.user, (trx) =>
      trx
        .updateTable('oauth_states')
        .set({
          created_at: new Date(Date.now() - 20 * 60_000),
          expires_at: new Date(Date.now() - 6 * 60_000),
        })
        .execute(),
    );
    const res = await c.request('POST', '/v1/connections/oauth/callback', body);
    expect(res.statusCode).toBe(400);
    expect(reasonOf(res).details?.reason).toBe('OAUTH_STATE_EXPIRED');
  });

  it('maps a declined consent, a partial grant and a refused exchange to their reasons', async () => {
    const c = await newClient(h);
    const mailbox = addMailbox(h, c);
    h.google.setLoginAccount(mailbox);

    h.google.consent.deny = true;
    const denied = await startOAuth(c, 'google', ['mail.read']);
    const deniedParams = await consent(denied.authorizationUrl);
    expect(deniedParams.get('error')).toBe('access_denied');
    const deniedRes = await c.request(
      'POST',
      '/v1/connections/oauth/callback',
      callbackBody(deniedParams),
    );
    expect(deniedRes.statusCode).toBe(400);
    expect(deniedRes.json()).toMatchObject({
      error: { code: 'VALIDATION_FAILED', details: { reason: 'OAUTH_DENIED', provider: 'google' } },
    });
    h.google.consent.deny = false;

    h.google.consent.grantOnly = [...OAUTH_SCOPES.google.identity];
    const partial = await startOAuth(c, 'google', ['mail.read']);
    const partialRes = await c.request(
      'POST',
      '/v1/connections/oauth/callback',
      callbackBody(await consent(partial.authorizationUrl)),
    );
    expect(partialRes.statusCode).toBe(400);
    expect(reasonOf(partialRes).details?.reason).toBe('OAUTH_SCOPE_NOT_GRANTED');
    h.google.consent.grantOnly = null;

    const refused = await startOAuth(c, 'google', ['mail.read']);
    const refusedParams = await consent(refused.authorizationUrl);
    h.google.failNext(
      { method: 'POST', path: '/token' },
      { status: 400, body: { error: 'invalid_grant', error_description: 'Bad Request' } },
    );
    const refusedRes = await c.request(
      'POST',
      '/v1/connections/oauth/callback',
      callbackBody(refusedParams),
    );
    expect(refusedRes.statusCode).toBe(422);
    expect(refusedRes.json()).toMatchObject({
      error: {
        code: 'CONNECTION_FAILED',
        details: { reason: 'OAUTH_EXCHANGE_FAILED', provider: 'google' },
      },
    });
    // The error says what happened, never echoes the code or the provider's own text.
    expect(refusedRes.body).not.toContain(refusedParams.get('code')!);
    expect(refusedRes.body).not.toContain('invalid_grant');

    // The provider is down during the exchange: the same honest failure, nothing stored.
    const down = await startOAuth(c, 'google', ['mail.read']);
    const downParams = await consent(down.authorizationUrl);
    h.google.failNext({ method: 'POST', path: '/token' }, h.google.errors.unavailable(503));
    const downRes = await c.request(
      'POST',
      '/v1/connections/oauth/callback',
      callbackBody(downParams),
    );
    expect(downRes.statusCode).toBe(422);
    expect(reasonOf(downRes).details?.reason).toBe('OAUTH_EXCHANGE_FAILED');

    const rows = await withContext(h.db, c.user, (trx) =>
      trx.selectFrom('connections').select('id').execute(),
    );
    expect(rows).toHaveLength(0);
  });

  it('validates the body: exactly one of code and error', async () => {
    const c = await newClient(h);
    for (const payload of [
      { state: 'x'.repeat(43) },
      { state: 'x'.repeat(43), code: 'a', error: 'access_denied' },
      { code: 'a' },
    ]) {
      const res = await c.request('POST', '/v1/connections/oauth/callback', payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(reasonOf(res).code).toBe('VALIDATION_FAILED');
    }
  });
});

describe('expired connections and reconnecting (scenario 9)', () => {
  it('shows an expired connection, reconnects the same account and offers the failed tasks for retry', async () => {
    const c = await newClient(h);
    const mailbox = addMailbox(h, c);
    const { connection } = await connectOAuth(h, c, 'google', ['mail.read'], { mailbox });
    await withContext(h.db, c.user, (trx) =>
      trx
        .updateTable('connections')
        .set({ status: 'expired', status_reason: 'GRANT_INVALID' })
        .where('id', '=', connection.id)
        .execute(),
    );
    const failed = async (owner: Client, provider: string) =>
      withContext(h.db, owner.user, async (trx) => {
        const conv = await trx
          .insertInto('conversations')
          .values({ tenant_id: owner.user.tenantId, user_id: owner.user.userId })
          .returning('id')
          .executeTakeFirstOrThrow();
        const t = await trx
          .insertInto('tasks')
          .values({
            tenant_id: owner.user.tenantId,
            user_id: owner.user.userId,
            conversation_id: conv.id,
            title: 'Summarize my unread emails',
            request: 'summarize my unread emails',
            source: 'text',
            status: 'FAILED',
            error: JSON.stringify({
              code: 'CONNECTION_REQUIRED',
              reason: 'CONNECTION_EXPIRED',
              params: { provider },
              message: 'Reconnect',
              retryable: true,
            }),
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        return t.id;
      });
    const taskId = await failed(c, 'google');
    await failed(c, 'microsoft'); // another provider: not offered
    const stranger = await newClient(h);
    await failed(stranger, 'google'); // another user: never visible

    const listed = (await c.request('GET', '/v1/connections')).json<{ items: Connection[] }>();
    expect(listed.items[0]).toMatchObject({
      id: connection.id,
      status: 'expired',
      statusReason: 'GRANT_INVALID',
    });

    const result = await connectOAuth(h, c, 'google', ['mail.read'], {
      mailbox,
      connectionId: connection.id,
      returnTo: `/tasks/${taskId}`,
    });
    expect(result.connection).toMatchObject({
      id: connection.id,
      status: 'active',
      statusReason: null,
    });
    expect(result.returnTo).toBe(`/tasks/${taskId}`);
    expect(result.resumableTaskIds).toEqual([taskId]);
  });

  it('refuses reconnecting with a different account (409) and keeps the connection as it was', async () => {
    const c = await newClient(h);
    const mailbox = addMailbox(h, c);
    const other = addMailbox(h, c, 'other');
    const { connection } = await connectOAuth(h, c, 'google', ['mail.read'], { mailbox });
    h.google.setLoginAccount(other);
    const start = await startOAuth(c, 'google', ['mail.send'], { connectionId: connection.id });
    const res = await c.request(
      'POST',
      '/v1/connections/oauth/callback',
      callbackBody(await consent(start.authorizationUrl)),
    );
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: {
        code: 'CONFLICT',
        details: { reason: 'OAUTH_ACCOUNT_MISMATCH', provider: 'google' },
      },
    });
    const listed = (await c.request('GET', '/v1/connections')).json<{ items: Connection[] }>();
    expect(listed.items[0]).toMatchObject({
      accountIdentifier: mailbox,
      capabilities: ['mail.read'],
    });
  });
});

describe('POST /v1/connections/:id/test (OAuth)', () => {
  it('re-verifies with the provider: verified now, expired when the provider refuses the grant', async () => {
    const c = await newClient(h);
    const mailbox = addMailbox(h, c);
    const { connection } = await connectOAuth(h, c, 'google', ['mail.read'], { mailbox });
    const userinfoCalls = () => h.google.requests.filter((r) => r.path === '/v1/userinfo').length;

    // Active: the identity endpoint is asked with a valid token; verified now.
    const before = userinfoCalls();
    const ok = await c.request('POST', `/v1/connections/${connection.id}/test`);
    expect(ok.statusCode).toBe(200);
    expect(userinfoCalls()).toBe(before + 1);
    const verified = ok.json<Connection>();
    expect(verified.status).toBe('active');
    expect(new Date(verified.lastVerifiedAt!).getTime()).toBeGreaterThanOrEqual(
      new Date(connection.lastVerifiedAt!).getTime(),
    );

    // The token is refused even after a forced refresh: expired TOKEN_REJECTED, never "verified".
    h.google.failNext({ path: '/v1/userinfo' }, h.google.errors.invalidToken(), 2);
    const refused = await c.request('POST', `/v1/connections/${connection.id}/test`);
    expect(refused.statusCode).toBe(200);
    expect(refused.json<Connection>()).toMatchObject({
      status: 'expired',
      statusReason: 'TOKEN_REJECTED',
      lastVerifiedAt: verified.lastVerifiedAt,
    });
    // Expired: nothing to ask; the row stays as it is until reconnecting.
    const again = await c.request('POST', `/v1/connections/${connection.id}/test`);
    expect(again.json<Connection>()).toMatchObject({
      status: 'expired',
      statusReason: 'TOKEN_REJECTED',
    });
  });

  it('a provider that does not answer changes nothing (503)', async () => {
    const c = await newClient(h);
    const mailbox = addMailbox(h, c);
    const { connection } = await connectOAuth(h, c, 'google', ['mail.read'], { mailbox });
    h.google.failNext({ path: '/v1/userinfo' }, h.google.errors.unavailable(503), 1);
    const res = await c.request('POST', `/v1/connections/${connection.id}/test`);
    expect(res.statusCode).toBe(503);
    const listed = (await c.request('GET', '/v1/connections')).json<{ items: Connection[] }>();
    expect(listed.items.find((i) => i.id === connection.id)).toMatchObject({
      status: 'active',
      lastVerifiedAt: connection.lastVerifiedAt,
    });
  });
});

describe('DELETE /v1/connections/:id (OAuth)', () => {
  it('disconnects Google: the row and its watches are gone and the grant is revoked at Google', async () => {
    const c = await newClient(h);
    const mailbox = addMailbox(h, c);
    const { connection } = await connectOAuth(h, c, 'google', ['mail.read', 'calendar.read'], {
      mailbox,
    });
    const watchId = await seedWatch(h, c.user, connection.id);
    const refreshTokens = [...h.google.oauth.refreshTokens.entries()]
      .filter(([, r]) => r.email === mailbox)
      .map(([t]) => t);
    expect(refreshTokens).toHaveLength(1);

    // Someone else cannot disconnect it.
    const bob = await newClient(h);
    expect((await bob.request('DELETE', `/v1/connections/${connection.id}`)).statusCode).toBe(404);

    const res = await c.request('DELETE', `/v1/connections/${connection.id}`);
    expect(res.statusCode).toBe(204);
    expect((await c.request('GET', '/v1/connections')).json()).toEqual({ items: [] });
    const left = await withContext(h.db, c.user, async (trx) => ({
      connections: await trx.selectFrom('connections').select('id').execute(),
      watches: await trx
        .selectFrom('email_watches')
        .select('id')
        .where('id', '=', watchId)
        .execute(),
    }));
    expect(left).toEqual({ connections: [], watches: [] });
    // Queued for revocation (definer-only outbox), then revoked at the provider by the drain.
    const queued = await ownerQuery<{ provider: string }>(
      'select provider from oauth_revocations where connection_id = $1',
      [connection.id],
    );
    expect(queued).toEqual([{ provider: 'google' }]);
    await drainRevocations(h);
    expect(h.google.oauth.revoked).toContain(refreshTokens[0]);
    expect(
      await ownerQuery('select id from oauth_revocations where connection_id = $1', [
        connection.id,
      ]),
    ).toHaveLength(0);
    const audit = await ownerQuery<{ metadata: Record<string, unknown> }>(
      `select metadata from audit_events where action = 'connection.deleted' and target_id = $1`,
      [connection.id],
    );
    expect(audit[0]!.metadata).toMatchObject({ provider: 'google', revocation: 'provider' });

    // A second delete is a 404; connecting again creates a fresh connection.
    expect((await c.request('DELETE', `/v1/connections/${connection.id}`)).statusCode).toBe(404);
    const again = await connectOAuth(h, c, 'google', ['mail.read'], { mailbox });
    expect(again.connection.id).not.toBe(connection.id);
  });

  it('disconnects Microsoft locally (no per-app revocation endpoint) and says so in the audit', async () => {
    const c = await newClient(h);
    const mailbox = addMailbox(h, c);
    const { connection } = await connectOAuth(h, c, 'microsoft', ['mail.read'], { mailbox });
    expect((await c.request('DELETE', `/v1/connections/${connection.id}`)).statusCode).toBe(204);
    expect(
      await ownerQuery('select id from oauth_revocations where connection_id = $1', [
        connection.id,
      ]),
    ).toHaveLength(0);
    const audit = await ownerQuery<{ metadata: Record<string, unknown> }>(
      `select metadata from audit_events where action = 'connection.deleted' and target_id = $1`,
      [connection.id],
    );
    expect(audit[0]!.metadata).toMatchObject({ provider: 'microsoft', revocation: 'local_only' });
    const events = await withContext(h.db, c.user, (trx) =>
      trx
        .selectFrom('task_events')
        .select('data')
        .where('type', '=', 'connection.changed')
        .orderBy('id', 'desc')
        .limit(1)
        .execute(),
    );
    expect(events[0]!.data).toMatchObject({
      connectionId: connection.id,
      provider: 'microsoft',
      status: 'revoked',
      change: 'disconnected',
    });
  });
});
