/**
 * OAuth token custody (docs/adr/0016): the ONLY code that opens OAuth
 * envelopes. One SecretBox envelope per connection (AAD
 * oauth:<user>:<provider>:<connection id>); refresh before expiry under the
 * connection's row lock (across processes) plus an in-process single flight
 * (within one), rotation persisted in the same transaction, and expiry
 * detected — never guessed: invalid_grant → 'expired' GRANT_INVALID; a 401
 * right after a refresh → 'expired' TOKEN_REJECTED; a 403 for a missing
 * scope → the capability is removed (SCOPE_MISSING). Each transition notifies
 * once (connection_expired), emits connection.changed and is audited.
 */
import {
  OAUTH_LIMITS,
  type ConnectionCapability,
  type ConnectionStatusReason,
} from '@jarvis/contracts';
import { sql } from 'kysely';
import { withContext, type DbContext, type Trx } from '../../db/pool';
import type { ConnectionRow } from '../../db/types';
import type { SecretBox } from '../../lib/crypto';
import { AgentError } from '../agent/errors';
import { audit } from '../audit/audit';
import { appendEvent } from '../events/events';
import { createNotification } from '../notifications/create';
import {
  OAUTH_ADAPTERS,
  capabilitiesFromScopes,
  expiresAtOf,
  grantedScopes,
  tokenRequest,
} from './oauth-client';
import { connectionChanged } from './bus';
import {
  PROVIDER_NAME,
  isOAuthProvider,
  type IntegrationDeps,
  type OAuthProvider,
  type TokenSet,
} from './types';

/** AAD of a connection's token envelope: swapping envelopes between rows or users fails to open. */
export const oauthAad = (userId: string, provider: string, connectionId: string) =>
  `oauth:${userId}:${provider}:${connectionId}`;

export function sealTokens(
  box: SecretBox,
  row: { user_id: string; provider: string; id: string },
  tokens: TokenSet,
): { secret_ciphertext: Buffer; secret_key_id: string } {
  return {
    secret_ciphertext: box.seal(
      JSON.stringify(tokens),
      oauthAad(row.user_id, row.provider, row.id),
    ),
    secret_key_id: box.keyId,
  };
}

export function openTokens(
  box: SecretBox,
  row: Pick<ConnectionRow, 'secret_ciphertext' | 'user_id' | 'provider' | 'id'>,
): TokenSet {
  if (!row.secret_ciphertext) throw new Error('connection has no token envelope');
  return JSON.parse(
    box.open(row.secret_ciphertext, oauthAad(row.user_id, row.provider, row.id)),
  ) as TokenSet;
}

/* ------------------------------------------------------------------ */
/* Errors (TaskError reasons of contracts; offer "Reconnect")          */
/* ------------------------------------------------------------------ */

export function connectionExpiredError(provider: OAuthProvider): AgentError {
  return new AgentError(
    'CONNECTION_REQUIRED',
    `The ${PROVIDER_NAME[provider]} connection has expired. Reconnect it in Settings → Connections, then retry.`,
    { retryable: true, reason: 'CONNECTION_EXPIRED', params: { provider } },
  );
}

export function connectionMissingError(provider: string): AgentError {
  return new AgentError(
    'CONNECTION_REQUIRED',
    `This needs a connected ${isOAuthProvider(provider) ? PROVIDER_NAME[provider] : provider} account. Connect it in Settings → Connections, then retry.`,
    { retryable: true, reason: 'CONNECTION_MISSING', params: { provider } },
  );
}

export function scopeMissingError(
  provider: OAuthProvider,
  capability: ConnectionCapability,
): AgentError {
  return new AgentError(
    'CONNECTION_REQUIRED',
    `The ${PROVIDER_NAME[provider]} connection does not allow this (${capability}). Reconnect it and allow that permission, then retry.`,
    { retryable: true, reason: 'CONNECTION_SCOPE_MISSING', params: { provider, capability } },
  );
}

export function providerUnavailableError(provider: OAuthProvider): AgentError {
  return new AgentError(
    'TOOL_FAILED',
    `${PROVIDER_NAME[provider]} did not answer. Nothing was changed; try again in a moment.`,
    { retryable: true, transient: true, reason: 'PROVIDER_UNAVAILABLE', params: { provider } },
  );
}

/* ------------------------------------------------------------------ */
/* State transitions (inside the caller's transaction, row locked)     */
/* ------------------------------------------------------------------ */

const LAST_ERROR: Record<ConnectionStatusReason, string> = {
  GRANT_INVALID: 'The provider no longer accepts JARVIS’s access (expired or revoked). Reconnect.',
  TOKEN_REJECTED: 'The provider rejected a freshly refreshed access token. Reconnect.',
  SCOPE_MISSING: 'A permission JARVIS relies on was withdrawn. Reconnect and allow it.',
  PROVIDER_ERROR: 'The provider kept failing.',
};

/**
 * active → expired, with one notification, an event and an audit entry. A
 * connection that is not active any more is left alone (the transition
 * already happened: no second notification).
 */
export async function markExpiredIn(
  trx: Trx,
  ctx: DbContext,
  connectionId: string,
  reason: 'GRANT_INVALID' | 'TOKEN_REJECTED',
): Promise<boolean> {
  const row = await trx
    .updateTable('connections')
    .set({ status: 'expired', status_reason: reason, last_error: LAST_ERROR[reason] })
    .where('id', '=', connectionId)
    .where('status', '=', 'active')
    .returning(['id', 'provider', 'account_identifier'])
    .executeTakeFirst();
  if (!row) return false;
  await appendEvent(trx, ctx, {
    taskId: null,
    type: 'connection.changed',
    data: {
      connectionId: row.id,
      provider: row.provider,
      status: 'expired',
      statusReason: reason,
      change: 'expired',
    },
  });
  await createNotification(trx, ctx, 'connection_expired', null, {
    provider: row.provider,
    connectionId: row.id,
    ...(row.account_identifier ? { accountIdentifier: row.account_identifier } : {}),
  });
  await audit(trx, {
    tenantId: ctx.tenantId,
    actorType: 'system',
    actorId: ctx.userId,
    action: 'connection.expired',
    targetType: 'connection',
    targetId: row.id,
    metadata: { provider: row.provider, reason },
  });
  connectionChanged(row.id);
  return true;
}

/** A 401 after a forced refresh: the token itself is refused → expired (TOKEN_REJECTED). */
export async function markTokenRejected(
  deps: IntegrationDeps,
  ctx: DbContext,
  connectionId: string,
): Promise<void> {
  await withContext(deps.db, ctx, (trx) => markExpiredIn(trx, ctx, connectionId, 'TOKEN_REJECTED'));
}

/**
 * A 403 for a missing scope: the capability is removed (status stays active,
 * status_reason SCOPE_MISSING), notified once per capability lost.
 */
export async function markScopeMissing(
  deps: IntegrationDeps,
  ctx: DbContext,
  connectionId: string,
  capability: ConnectionCapability,
): Promise<void> {
  await withContext(deps.db, ctx, async (trx) => {
    const row = await trx
      .updateTable('connections')
      .set({
        capabilities: sql<ConnectionCapability[]>`array_remove(capabilities, ${capability}::text)`,
        status_reason: 'SCOPE_MISSING',
        last_error: LAST_ERROR.SCOPE_MISSING,
      })
      .where('id', '=', connectionId)
      .where(sql<boolean>`${capability}::text = ANY(capabilities)`)
      .returning(['id', 'provider', 'status', 'account_identifier'])
      .executeTakeFirst();
    if (!row) return;
    await appendEvent(trx, ctx, {
      taskId: null,
      type: 'connection.changed',
      data: {
        connectionId: row.id,
        provider: row.provider,
        status: row.status,
        statusReason: 'SCOPE_MISSING',
        change: 'capabilities',
      },
    });
    await createNotification(trx, ctx, 'connection_expired', null, {
      provider: row.provider,
      connectionId: row.id,
      ...(row.account_identifier ? { accountIdentifier: row.account_identifier } : {}),
    });
    await audit(trx, {
      tenantId: ctx.tenantId,
      actorType: 'system',
      actorId: ctx.userId,
      action: 'connection.scope_missing',
      targetType: 'connection',
      targetId: row.id,
      metadata: { provider: row.provider, capability },
    });
    connectionChanged(row.id);
  });
}

/* ------------------------------------------------------------------ */
/* Access tokens                                                       */
/* ------------------------------------------------------------------ */

type RefreshOutcome =
  | { kind: 'ok'; token: string; connection: ConnectionRow }
  | { kind: 'expired'; provider: OAuthProvider }
  | { kind: 'missing'; provider: string }
  | { kind: 'unavailable'; provider: OAuthProvider };

/**
 * One refresh in flight per connection and database pool in this process (a
 * process has one pool; the row lock covers other processes and pools).
 */
const inflightByPool = new WeakMap<object, Map<string, Promise<RefreshOutcome>>>();

const skewMs = OAUTH_LIMITS.refreshSkewSeconds * 1000;

function isFresh(row: Pick<ConnectionRow, 'token_expires_at'>, now = Date.now()): boolean {
  return !!row.token_expires_at && new Date(row.token_expires_at).getTime() - now > skewMs;
}

/**
 * A valid access token for this user's connection, refreshed under the row
 * lock when it expires within OAUTH_LIMITS.refreshSkewSeconds (or when
 * `forceRefresh`: the provider just answered 401 to `rejectedToken`).
 * Throws AgentError CONNECTION_REQUIRED with reason CONNECTION_MISSING /
 * CONNECTION_EXPIRED { provider } (after marking the row expired, with one
 * connection_expired notification), or TOOL_FAILED PROVIDER_UNAVAILABLE.
 */
export async function accessToken(
  deps: IntegrationDeps,
  ctx: DbContext,
  connectionId: string,
  opts: { forceRefresh?: boolean; rejectedToken?: string; signal?: AbortSignal } = {},
): Promise<{ token: string; connection: ConnectionRow }> {
  const row = await withContext(deps.db, ctx, (trx) =>
    trx.selectFrom('connections').selectAll().where('id', '=', connectionId).executeTakeFirst(),
  );
  if (!row || row.status === 'revoked') throw connectionMissingError(row?.provider ?? 'oauth');
  if (!isOAuthProvider(row.provider)) throw connectionMissingError(row.provider);
  if (row.status === 'expired') throw connectionExpiredError(row.provider);
  if (row.status !== 'active') throw connectionMissingError(row.provider);
  if (!opts.forceRefresh && isFresh(row)) {
    return { token: openTokens(deps.secrets, row).accessToken, connection: row };
  }
  let inflight = inflightByPool.get(deps.db);
  if (!inflight) {
    inflight = new Map();
    inflightByPool.set(deps.db, inflight);
  }
  const flights = inflight;
  let pending = flights.get(connectionId);
  if (!pending) {
    pending = refreshLocked(deps, ctx, connectionId, {
      force: !!opts.forceRefresh,
      rejectedToken: opts.rejectedToken ?? null,
      signal: opts.signal,
    }).finally(() => flights.delete(connectionId));
    flights.set(connectionId, pending);
  }
  const outcome = await pending;
  switch (outcome.kind) {
    case 'ok':
      return { token: outcome.token, connection: outcome.connection };
    case 'expired':
      throw connectionExpiredError(outcome.provider);
    case 'missing':
      throw connectionMissingError(outcome.provider);
    case 'unavailable':
      throw providerUnavailableError(outcome.provider);
  }
}

/**
 * The refresh itself, under SELECT … FOR UPDATE on the connection. The winner
 * of a race refreshes; the others find a fresh token after the lock and use
 * it. A response with a new refresh_token replaces the stored one in the same
 * transaction (rotation); invalid_grant expires the connection in it.
 */
async function refreshLocked(
  deps: IntegrationDeps,
  ctx: DbContext,
  connectionId: string,
  opts: { force: boolean; rejectedToken: string | null; signal?: AbortSignal },
): Promise<RefreshOutcome> {
  return withContext(deps.db, ctx, async (trx): Promise<RefreshOutcome> => {
    const row = await trx
      .selectFrom('connections')
      .selectAll()
      .where('id', '=', connectionId)
      .forUpdate()
      .executeTakeFirst();
    if (!row || row.status === 'revoked' || !isOAuthProvider(row.provider))
      return { kind: 'missing', provider: row?.provider ?? 'oauth' };
    const provider = row.provider;
    if (row.status === 'expired') return { kind: 'expired', provider };
    if (row.status !== 'active') return { kind: 'missing', provider };
    let tokens: TokenSet;
    try {
      tokens = openTokens(deps.secrets, row);
    } catch {
      // An envelope this server cannot open (key rotated away, tampered row): reconnect.
      await markExpiredIn(trx, ctx, row.id, 'GRANT_INVALID');
      return { kind: 'expired', provider };
    }
    // Someone refreshed while we waited for the lock: use theirs.
    if (isFresh(row) && (!opts.force || tokens.accessToken !== opts.rejectedToken))
      return { kind: 'ok', token: tokens.accessToken, connection: row };
    if (!tokens.refreshToken) {
      await markExpiredIn(trx, ctx, row.id, 'GRANT_INVALID');
      return { kind: 'expired', provider };
    }
    if (!deps.config.oauth[provider]) return { kind: 'unavailable', provider };
    const adapter = OAUTH_ADAPTERS[provider];
    const res = await tokenRequest(
      deps.config,
      provider,
      {
        grant_type: 'refresh_token',
        refresh_token: tokens.refreshToken,
        ...adapter.tokenExtras(tokens.scope),
      },
      opts.signal,
    );
    if (res.kind === 'invalid_grant') {
      await markExpiredIn(trx, ctx, row.id, 'GRANT_INVALID');
      return { kind: 'expired', provider };
    }
    if (res.kind !== 'ok') return { kind: 'unavailable', provider };
    const now = new Date();
    const scope = grantedScopes(res.tokens, tokens.scope);
    const next: TokenSet = {
      accessToken: res.tokens.access_token,
      // Rotation: a new refresh token replaces the old one (Microsoft rotates on every refresh).
      refreshToken: res.tokens.refresh_token ?? tokens.refreshToken,
      expiresAt: expiresAtOf(res.tokens, now.getTime()).toISOString(),
      scope,
      tokenType: res.tokens.token_type ?? 'Bearer',
    };
    // A refresh never adds capabilities; it may reveal that one was withdrawn.
    const stillGranted = new Set(capabilitiesFromScopes(provider, scope));
    const capabilities = row.capabilities.filter((c) => stillGranted.has(c));
    const updated = await trx
      .updateTable('connections')
      .set({
        ...sealTokens(deps.secrets, row, next),
        token_expires_at: new Date(next.expiresAt),
        token_refreshed_at: now,
        granted_scopes: scope.slice(0, 32),
        capabilities,
        ...(capabilities.length < row.capabilities.length
          ? { status_reason: 'SCOPE_MISSING' as const }
          : {}),
      })
      .where('id', '=', row.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return { kind: 'ok', token: next.accessToken, connection: updated };
  });
}
