/**
 * Token custody against the mock providers: refresh before expiry with a
 * single flight (in one process and across two database pools), refresh-token
 * rotation, invalid_grant → expired + one notification, 401 → one forced
 * refresh, 401 after a refresh → TOKEN_REJECTED, 403 insufficient scope →
 * capability removed, 429 Retry-After, 5xx, and the revocation drain.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withContext } from '../../../src/db/pool';
import { AgentError } from '../../../src/modules/agent/errors';
import { mailClient } from '../../../src/modules/integrations/mail';
import { drainRevocations, purgeOAuthStates } from '../../../src/modules/integrations/revocation';
import { accessToken, openTokens } from '../../../src/modules/integrations/tokens';
import { asOwner, auditActions } from '../agent/harness';
import { testDb } from '../helpers';
import {
  connect,
  createIntegrationsHarness,
  newUserWithMailbox,
  type IntegrationsHarness,
} from './harness';

let h: IntegrationsHarness;
beforeAll(async () => {
  h = await createIntegrationsHarness();
});
afterAll(() => h.close());

async function nearExpiry(connectionId: string) {
  await asOwner(
    `UPDATE connections SET token_expires_at = now() + interval '60 seconds' WHERE id = $1`,
    [connectionId],
  );
}

async function row(user: { tenantId: string; userId: string }, id: string) {
  return withContext(h.db, user, (trx) =>
    trx.selectFrom('connections').selectAll().where('id', '=', id).executeTakeFirstOrThrow(),
  );
}

async function notifications(user: { tenantId: string; userId: string }) {
  return withContext(h.db, user, (trx) => trx.selectFrom('notifications').selectAll().execute());
}

async function agentError(p: Promise<unknown>): Promise<AgentError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof AgentError) return e;
    throw e;
  }
  throw new Error('expected an AgentError');
}

describe('refresh', () => {
  it('refreshes before expiry once for concurrent callers (single flight in one process)', async () => {
    const user = await newUserWithMailbox(h);
    const { connection } = await connect(h, user, 'google', ['mail.read']);
    const before = h.google.oauth.grantTypes.refresh_token;
    const old = openTokens(h.secrets, await row(user, connection.id)).accessToken;
    // Fresh: no refresh at all.
    expect((await accessToken(h, user, connection.id)).token).toBe(old);
    expect(h.google.oauth.grantTypes.refresh_token).toBe(before);
    await nearExpiry(connection.id);
    const [a, b] = await Promise.all([
      accessToken(h, user, connection.id),
      accessToken(h, user, connection.id),
    ]);
    expect(a.token).toBe(b.token);
    expect(a.token).not.toBe(old);
    expect(h.google.oauth.grantTypes.refresh_token).toBe(before + 1);
    const refreshed = await row(user, connection.id);
    expect(refreshed.token_expires_at!.getTime()).toBeGreaterThan(Date.now() + 3_000_000);
    expect(refreshed.token_refreshed_at).not.toBeNull();
  });

  it('two workers (separate pools) refresh once: the row lock serialises them, the loser reuses the token', async () => {
    const user = await newUserWithMailbox(h);
    const { connection } = await connect(h, user, 'google', ['mail.read']);
    await nearExpiry(connection.id);
    const other = { ...h, db: testDb() };
    try {
      const before = h.google.oauth.grantTypes.refresh_token;
      // A slow token endpoint keeps the first refresher inside its lock.
      h.google.failNext(
        { method: 'POST', path: '/token' },
        { status: 200, delayMs: 400, passThrough: true },
      );
      const [a, b] = await Promise.all([
        accessToken(h, user, connection.id),
        accessToken(other, user, connection.id),
      ]);
      expect(a.token).toBe(b.token);
      expect(h.google.oauth.grantTypes.refresh_token).toBe(before + 1);
    } finally {
      await other.db.destroy();
    }
  });

  it('stores a rotated refresh token in the same transaction (Microsoft rotates on every refresh)', async () => {
    const user = await newUserWithMailbox(h);
    const { connection } = await connect(h, user, 'microsoft', ['mail.read']);
    const first = openTokens(h.secrets, await row(user, connection.id)).refreshToken!;
    await nearExpiry(connection.id);
    await accessToken(h, user, connection.id);
    const second = openTokens(h.secrets, await row(user, connection.id)).refreshToken!;
    expect(second).not.toBe(first);
    // The old one is used up at the provider…
    expect(h.microsoft.oauth.refreshTokens.get(first)!.valid).toBe(false);
    // …and the stored one keeps working.
    await nearExpiry(connection.id);
    const third = await accessToken(h, user, connection.id);
    expect(third.token).toMatch(/^at_/);
    expect((await row(user, connection.id)).status).toBe('active');
  });
});

describe('expiry and provider errors', () => {
  it('invalid_grant on refresh: expired (GRANT_INVALID), one notification, event, audit; CONNECTION_EXPIRED', async () => {
    const user = await newUserWithMailbox(h);
    const { connection } = await connect(h, user, 'google', ['mail.read']);
    h.google.revokeGrants(user.mailbox);
    await nearExpiry(connection.id);
    const err = await agentError(accessToken(h, user, connection.id));
    expect(err.toTaskError()).toMatchObject({
      code: 'CONNECTION_REQUIRED',
      reason: 'CONNECTION_EXPIRED',
      params: { provider: 'google' },
      retryable: true,
    });
    const r = await row(user, connection.id);
    expect(r).toMatchObject({ status: 'expired', status_reason: 'GRANT_INVALID' });
    const again = await agentError(accessToken(h, user, connection.id));
    expect(again.reason).toBe('CONNECTION_EXPIRED');
    const n = await notifications(user);
    expect(n.filter((x) => x.kind === 'connection_expired')).toHaveLength(1);
    expect(n[0]!.data).toMatchObject({
      provider: 'google',
      connectionId: connection.id,
      accountIdentifier: user.mailbox,
    });
    const events = await withContext(h.db, user, (trx) =>
      trx
        .selectFrom('task_events')
        .select(['type', 'data'])
        .where('type', '=', 'connection.changed')
        .execute(),
    );
    expect(events.map((e) => (e.data as { change?: string }).change)).toContain('expired');
    expect(await auditActions(user.userId)).toContain('connection.expired');
  });

  it('401 invalid_token: one forced refresh and one retry succeed', async () => {
    const user = await newUserWithMailbox(h);
    const { connection } = await connect(h, user, 'google', ['mail.read']);
    h.google.addMessage(user.mailbox, {
      from: 'Anna <anna@example.org>',
      subject: 'Hello',
      body: 'Hi there, how are you doing today?',
    });
    h.google.expireAccessTokens(user.mailbox);
    const before = h.google.oauth.grantTypes.refresh_token;
    const client = mailClient(h, user, {
      id: connection.id,
      provider: 'google',
      accountIdentifier: user.mailbox,
    });
    const threads = await client.search({ limit: 5 });
    expect(threads).toHaveLength(1);
    expect(h.google.oauth.grantTypes.refresh_token).toBe(before + 1);
    expect((await row(user, connection.id)).status).toBe('active');
  });

  it('401 right after a refresh: expired (TOKEN_REJECTED)', async () => {
    const user = await newUserWithMailbox(h);
    const { connection } = await connect(h, user, 'microsoft', ['mail.read']);
    h.microsoft.failNext(
      { path: /^\/v1\.0\/me\/(mailFolders|messages)/ },
      h.microsoft.errors.invalidToken(),
      2,
    );
    const client = mailClient(h, user, {
      id: connection.id,
      provider: 'microsoft',
      accountIdentifier: user.mailbox,
    });
    const err = await agentError(client.search({ limit: 5 }));
    expect(err.reason).toBe('CONNECTION_EXPIRED');
    expect(await row(user, connection.id)).toMatchObject({
      status: 'expired',
      status_reason: 'TOKEN_REJECTED',
    });
    expect((await notifications(user)).filter((x) => x.kind === 'connection_expired')).toHaveLength(
      1,
    );
  });

  it('403 insufficient scope: the capability is removed (SCOPE_MISSING), the connection stays active', async () => {
    const user = await newUserWithMailbox(h);
    const { connection } = await connect(h, user, 'google', ['mail.read', 'calendar.read']);
    h.google.failNext({ path: '/gmail/' }, h.google.errors.insufficientScope());
    const client = mailClient(h, user, {
      id: connection.id,
      provider: 'google',
      accountIdentifier: user.mailbox,
    });
    const err = await agentError(client.search({ limit: 5 }));
    expect(err.toTaskError()).toMatchObject({
      code: 'CONNECTION_REQUIRED',
      reason: 'CONNECTION_SCOPE_MISSING',
      params: { provider: 'google', capability: 'mail.read' },
    });
    expect(await row(user, connection.id)).toMatchObject({
      status: 'active',
      status_reason: 'SCOPE_MISSING',
      capabilities: ['calendar.read'],
    });
  });

  it('429 → PROVIDER_RATE_LIMITED with Retry-After seconds; 5xx → PROVIDER_UNAVAILABLE (transient)', async () => {
    const user = await newUserWithMailbox(h);
    const { connection } = await connect(h, user, 'microsoft', ['mail.read']);
    const client = mailClient(h, user, {
      id: connection.id,
      provider: 'microsoft',
      accountIdentifier: user.mailbox,
    });
    h.microsoft.failNext({ path: '/v1.0/me/' }, h.microsoft.errors.rateLimited(42));
    const limited = await agentError(client.search({ limit: 5 }));
    expect(limited.toTaskError()).toMatchObject({
      code: 'TOOL_FAILED',
      reason: 'PROVIDER_RATE_LIMITED',
      params: { provider: 'microsoft', seconds: 42 },
      retryable: true,
    });
    expect(limited.transient).toBe(true);
    h.microsoft.failNext({ path: '/v1.0/me/' }, h.microsoft.errors.unavailable(503));
    const down = await agentError(client.search({ limit: 5 }));
    expect(down.reason).toBe('PROVIDER_UNAVAILABLE');
    expect(down.transient).toBe(true);
    // A 5xx on a write that may have been processed is OUTCOME_UNKNOWN, never retried blindly.
    h.microsoft.failNext(
      { method: 'POST', path: '/v1.0/me/sendMail' },
      h.microsoft.errors.unavailable(500),
    );
    const send = await agentError(
      client.send({
        from: user.mailbox,
        to: ['x@example.org'],
        cc: [],
        subject: 's',
        body: 'b',
        messageIdHeader: '<k@x>',
        key: 'k-503',
      }),
    );
    expect(send.code).toBe('OUTCOME_UNKNOWN');
    expect((await row(user, connection.id)).status).toBe('active');
  });
});

describe('disconnect', () => {
  it('deleting a Google connection queues its tokens; the drain revokes them at Google', async () => {
    const user = await newUserWithMailbox(h);
    const { connection } = await connect(h, user, 'google', ['mail.read']);
    const refresh = openTokens(h.secrets, await row(user, connection.id)).refreshToken!;
    await withContext(h.db, user, (trx) =>
      trx.deleteFrom('connections').where('id', '=', connection.id).execute(),
    );
    const queued = await asOwner<{ id: string }>(
      'SELECT id FROM oauth_revocations WHERE connection_id = $1',
      [connection.id],
    );
    expect(queued).toHaveLength(1);
    // A transient failure backs off; the next round revokes.
    h.google.failNext({ method: 'POST', path: '/revoke' }, h.google.errors.unavailable(503));
    expect(await drainRevocations(h)).toBe(0);
    const [failed] = await asOwner<{ attempts: number; last_error: string; due_later: boolean }>(
      'SELECT attempts, last_error, not_before > now() AS due_later FROM oauth_revocations WHERE connection_id = $1',
      [connection.id],
    );
    expect(failed).toMatchObject({ attempts: 1, due_later: true });
    await asOwner('UPDATE oauth_revocations SET not_before = now() WHERE connection_id = $1', [
      connection.id,
    ]);
    expect(await drainRevocations(h)).toBeGreaterThanOrEqual(1);
    expect(h.google.oauth.revoked).toContain(refresh);
    expect(
      await asOwner('SELECT id FROM oauth_revocations WHERE connection_id = $1', [connection.id]),
    ).toHaveLength(0);
    // The grant is gone at the provider.
    expect(h.google.oauth.refreshTokens.get(refresh)!.valid).toBe(false);
  });

  it('an already revoked token (400 invalid_token) completes; Microsoft queues nothing', async () => {
    const user = await newUserWithMailbox(h);
    const g = await connect(h, user, 'google', ['mail.read']);
    const m = await connect(h, user, 'microsoft', ['mail.read']);
    h.google.revokeGrants(user.mailbox);
    await withContext(h.db, user, (trx) =>
      trx.deleteFrom('connections').where('user_id', '=', user.userId).execute(),
    );
    expect(
      await asOwner('SELECT id FROM oauth_revocations WHERE connection_id = $1', [m.connection.id]),
    ).toHaveLength(0);
    await drainRevocations(h);
    expect(
      await asOwner('SELECT id FROM oauth_revocations WHERE connection_id = $1', [g.connection.id]),
    ).toHaveLength(0);
  });

  it('reconnecting the same Google account before the drain ran cancels the queued revocation (0007)', async () => {
    const user = await newUserWithMailbox(h);
    const first = await connect(h, user, 'google', ['mail.read']);
    const other = await newUserWithMailbox(h);
    const theirs = await connect(h, other, 'google', ['mail.read']);
    await withContext(h.db, user, (trx) =>
      trx.deleteFrom('connections').where('id', '=', first.connection.id).execute(),
    );
    await withContext(h.db, other, (trx) =>
      trx.deleteFrom('connections').where('id', '=', theirs.connection.id).execute(),
    );
    const [queued] = await asOwner<{ provider_account_id: string }>(
      'SELECT provider_account_id FROM oauth_revocations WHERE connection_id = $1',
      [first.connection.id],
    );
    expect(queued?.provider_account_id).toBeTruthy();
    // The user connects the same account again before the drain ran: Google revokes per grant,
    // so revoking the old envelope now would kill the new connection.
    const again = await connect(h, user, 'google', ['mail.read']);
    expect(
      await asOwner('SELECT id FROM oauth_revocations WHERE connection_id = $1', [
        first.connection.id,
      ]),
    ).toHaveLength(0);
    // Another user's queued revocation is untouched and still revoked.
    expect(
      await asOwner('SELECT id FROM oauth_revocations WHERE connection_id = $1', [
        theirs.connection.id,
      ]),
    ).toHaveLength(1);
    await drainRevocations(h);
    const fresh = openTokens(h.secrets, await row(user, again.connection.id));
    expect(h.google.oauth.accessTokens.get(fresh.accessToken)?.valid).toBe(true);
    expect(
      await asOwner('SELECT id FROM oauth_revocations WHERE connection_id = $1', [
        theirs.connection.id,
      ]),
    ).toHaveLength(0);
  });

  it('purges used and expired authorization requests', async () => {
    await asOwner(
      "UPDATE oauth_states SET consumed_at = now() - interval '2 hours' WHERE consumed_at IS NOT NULL",
    );
    expect(await purgeOAuthStates(h)).toBeGreaterThan(0);
  });
});
