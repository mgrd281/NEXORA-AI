/**
 * OAuth 2.0 connections (docs/adr/0016, docs/architecture/phase-c.md §3.1):
 * authorization code + PKCE (S256) with a confidential client and a
 * server-side exchange; `state` = 32 random bytes stored only as SHA-256,
 * bound to the user AND the session that started it, single use, expiring
 * after OAUTH_LIMITS.stateTtlMinutes; exact redirect URIs; least-privilege
 * scopes per capability, requested incrementally; `iss` checked (RFC 9207);
 * the provider account must stay the same on reconnect.
 */
import { randomUUID } from 'node:crypto';
import {
  OAUTH_LIMITS,
  OAUTH_SCOPES,
  type Connection,
  type ConnectionCapability,
  type ConnectionProviderInfo,
  type OAuthCallbackRequest,
  type OAuthCallbackResult,
  type OAuthStartRequest,
  type OAuthStartResponse,
} from '@jarvis/contracts';
import { sql } from 'kysely';
import type { Config } from '../../config';
import { withContext } from '../../db/pool';
import type { ConnectionRow } from '../../db/types';
import type { RequestContext } from '../../http/context';
import { generateToken, sha256 } from '../../lib/crypto';
import { AppError, notFound } from '../../lib/errors';
import { isUniqueViolation } from '../agent/errors';
import { audit } from '../audit/audit';
import { appendEvent } from '../events/events';
import { connectionChanged } from './bus';
import {
  OAUTH_ADAPTERS,
  capabilitiesFromScopes,
  expiresAtOf,
  grantedScopes,
  normalizeScope,
  scopesFor,
  tokenRequest,
} from './oauth-client';
import { openTokens, sealTokens } from './tokens';
import {
  PROVIDER_NAME,
  isOAuthProvider,
  type IntegrationDeps,
  type OAuthProvider,
  type TokenSet,
} from './types';

/** AAD of a state's sealed PKCE verifier. */
export const stateAad = (userId: string, stateId: string) => `oauth-state:${userId}:${stateId}`;

/** RFC 7636 S256 code challenge. */
export const codeChallenge = (verifier: string) => sha256(verifier).toString('base64url');

const CAPABILITY_ORDER: readonly ConnectionCapability[] = [
  'mail.read',
  'mail.compose',
  'mail.send',
  'calendar.read',
  'calendar.write',
];
const ordered = (caps: Iterable<ConnectionCapability>) => {
  const set = new Set(caps);
  return CAPABILITY_ORDER.filter((c) => set.has(c));
};

/** GET /v1/connections/providers: what each provider is on this server (no secrets). */
export function providers(config: Config): ConnectionProviderInfo[] {
  const oauth = (provider: OAuthProvider): ConnectionProviderInfo => ({
    provider,
    kind: 'oauth',
    configured: config.oauth[provider] !== null,
    capabilities: CAPABILITY_ORDER.map((capability) => ({
      capability,
      scopes: [...OAUTH_SCOPES[provider][capability]],
    })),
    identityScopes: [...OAUTH_SCOPES[provider].identity],
    // Google has a revocation endpoint; Microsoft has none per app (docs/adr/0016).
    revocation: provider === 'google' ? 'provider' : 'local_only',
  });
  return [
    oauth('google'),
    oauth('microsoft'),
    {
      provider: 'smtp',
      kind: 'smtp',
      configured: true,
      capabilities: [],
      identityScopes: [],
      revocation: null,
    },
    {
      provider: 'web',
      kind: 'web',
      configured: true,
      capabilities: [],
      identityScopes: [],
      revocation: null,
    },
  ];
}

const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);

/** The public view of a connection (same fields as the connections routes send). */
export function connectionView(r: ConnectionRow): Connection {
  return {
    id: r.id,
    provider: r.provider,
    label: r.label,
    accountIdentifier: r.account_identifier,
    status: r.status,
    permissions: r.permissions,
    lastVerifiedAt: iso(r.last_verified_at),
    lastError: r.last_error,
    expiresAt: iso(r.expires_at),
    createdAt: new Date(r.created_at).toISOString(),
    capabilities: r.capabilities,
    scopes: r.granted_scopes,
    statusReason: r.status_reason,
  };
}

const reasonError = (
  code:
    'VALIDATION_FAILED' | 'SERVICE_UNAVAILABLE' | 'RATE_LIMITED' | 'CONFLICT' | 'CONNECTION_FAILED',
  message: string,
  reason: string,
  extra: Record<string, unknown> = {},
) => new AppError(code, message, { reason, ...extra });

/* ------------------------------------------------------------------ */
/* Start                                                               */
/* ------------------------------------------------------------------ */

export async function startOAuth(
  deps: IntegrationDeps,
  ctx: RequestContext,
  body: OAuthStartRequest,
): Promise<OAuthStartResponse> {
  const provider = body.provider;
  const client = deps.config.oauth[provider];
  if (!client)
    throw reasonError(
      'SERVICE_UNAVAILABLE',
      `${PROVIDER_NAME[provider]} is not configured on this server.`,
      'PROVIDER_NOT_CONFIGURED',
      { provider },
    );
  if (!deps.config.oauthRedirectUris.has(body.redirectUri))
    throw reasonError(
      'VALIDATION_FAILED',
      'This redirect URI is not one of the server’s allowed redirect URIs.',
      'REDIRECT_URI_NOT_ALLOWED',
    );
  const adapter = OAUTH_ADAPTERS[provider];
  const state = generateToken();
  const verifier = generateToken() + generateToken().slice(0, 21); // 64 chars of [A-Za-z0-9_-]
  const now = new Date();
  const expiresAt = new Date(now.getTime() + OAUTH_LIMITS.stateTtlMinutes * 60_000);

  const result = await withContext(deps.db, ctx, async (trx) => {
    let existing: ConnectionRow | undefined;
    if (body.connectionId) {
      existing = await trx
        .selectFrom('connections')
        .selectAll()
        .where('id', '=', body.connectionId)
        .where('status', '<>', 'revoked')
        .executeTakeFirst();
      if (!existing) throw notFound('Connection');
      if (!isOAuthProvider(existing.provider))
        throw reasonError(
          'VALIDATION_FAILED',
          'This connection does not use OAuth.',
          'CONNECTION_NOT_OAUTH',
        );
      if (existing.provider !== provider) throw notFound('Connection');
    }
    const pending = await trx
      .selectFrom('oauth_states')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('user_id', '=', ctx.userId)
      .where('consumed_at', 'is', null)
      .where('expires_at', '>', now)
      .executeTakeFirst();
    if (Number(pending?.n ?? 0) >= OAUTH_LIMITS.maxPendingStates)
      throw reasonError(
        'RATE_LIMITED',
        'Too many unfinished sign-ins. Finish or wait for one to expire.',
        'OAUTH_PENDING_LIMIT',
        { max: OAUTH_LIMITS.maxPendingStates },
      );
    // Incremental: an active connection asks only for what it does not have yet (Google keeps the
    // rest with include_granted_scopes); Microsoft tokens cover what each request names, so it asks
    // for the union. A reconnect (expired) asks again for everything requested.
    const reconnect = !existing || existing.status !== 'active';
    const have = existing && !reconnect ? existing.capabilities : [];
    const wanted = ordered(body.capabilities);
    const caps =
      provider === 'google'
        ? reconnect
          ? ordered([...wanted, ...(existing?.capabilities ?? [])])
          : wanted.filter((c) => !have.includes(c))
        : ordered([...wanted, ...(existing?.capabilities ?? [])]);
    const scopes = scopesFor(provider, caps.length ? caps : wanted);
    const id = randomUUID();
    await trx
      .insertInto('oauth_states')
      .values({
        id,
        tenant_id: ctx.tenantId,
        user_id: ctx.userId,
        session_id: ctx.sessionId,
        provider,
        capabilities: wanted,
        requested_scopes: scopes,
        state_hash: sha256(state),
        code_verifier_ciphertext: deps.secrets.seal(verifier, stateAad(ctx.userId, id)),
        code_verifier_key_id: deps.secrets.keyId,
        redirect_uri: body.redirectUri,
        connection_id: existing?.id ?? null,
        return_to: body.returnTo ?? null,
        created_at: now,
        expires_at: expiresAt,
      })
      .execute();
    await audit(trx, {
      tenantId: ctx.tenantId,
      actorType: 'user',
      actorId: ctx.userId,
      action: 'connection.oauth_started',
      targetType: 'connection',
      targetId: existing?.id,
      metadata: { provider, capabilities: wanted, incremental: !!existing && !reconnect },
    });
    return { scopes, incremental: !!existing && !reconnect };
  });

  return {
    authorizationUrl: adapter.authorizeUrl(deps.config, {
      state,
      codeChallenge: codeChallenge(verifier),
      scopes: result.scopes,
      redirectUri: body.redirectUri,
      incremental: result.incremental,
    }),
    expiresAt: expiresAt.toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/* Callback                                                            */
/* ------------------------------------------------------------------ */

const stateInvalid = () =>
  reasonError(
    'VALIDATION_FAILED',
    'This sign-in link is not valid (unknown, already used, or started elsewhere). Start again.',
    'OAUTH_STATE_INVALID',
  );

export async function completeOAuth(
  deps: IntegrationDeps,
  ctx: RequestContext,
  body: OAuthCallbackRequest,
): Promise<OAuthCallbackResult> {
  const hash = sha256(body.state);
  // 1. Consume the state (single use) — committed before anything else happens.
  const consumed = await withContext(deps.db, ctx, async (trx) => {
    const row = await trx
      .selectFrom('oauth_states')
      .selectAll()
      .where('state_hash', '=', hash)
      .where('user_id', '=', ctx.userId)
      .forUpdate()
      .executeTakeFirst();
    if (!row || row.consumed_at || row.session_id !== ctx.sessionId)
      return { kind: 'invalid' as const };
    const used = await trx
      .updateTable('oauth_states')
      .set({ consumed_at: new Date() })
      .where('id', '=', row.id)
      .where('consumed_at', 'is', null)
      .returningAll()
      .executeTakeFirst();
    if (!used) return { kind: 'invalid' as const };
    if (new Date(row.expires_at).getTime() <= Date.now()) return { kind: 'expired' as const };
    return { kind: 'ok' as const, row: used };
  });
  if (consumed.kind === 'invalid') throw stateInvalid();
  if (consumed.kind === 'expired')
    throw reasonError(
      'VALIDATION_FAILED',
      `The sign-in took longer than ${OAUTH_LIMITS.stateTtlMinutes} minutes. Start again.`,
      'OAUTH_STATE_EXPIRED',
    );
  const st = consumed.row;
  const provider = st.provider;
  const adapter = OAUTH_ADAPTERS[provider];
  if (!deps.config.oauth[provider])
    throw reasonError(
      'SERVICE_UNAVAILABLE',
      `${PROVIDER_NAME[provider]} is not configured on this server.`,
      'PROVIDER_NOT_CONFIGURED',
      { provider },
    );
  // 2. Mix-up defence: an issuer, when sent, must be this provider's.
  if (body.iss !== undefined && body.iss !== adapter.issuer(deps.config)) throw stateInvalid();
  if (body.error !== undefined) {
    await auditFailure(deps, ctx, provider, body.error === 'access_denied' ? 'denied' : 'error');
    if (body.error === 'access_denied')
      throw reasonError(
        'VALIDATION_FAILED',
        'The sign-in was declined at the provider.',
        'OAUTH_DENIED',
        {
          provider,
        },
      );
    throw exchangeFailed(provider);
  }
  // 3. Exchange the code (server side, with the PKCE verifier and the client secret).
  let verifier: string;
  try {
    verifier = deps.secrets.open(st.code_verifier_ciphertext, stateAad(st.user_id, st.id));
  } catch {
    throw stateInvalid();
  }
  const exchanged = await tokenRequest(deps.config, provider, {
    grant_type: 'authorization_code',
    code: body.code!,
    redirect_uri: st.redirect_uri,
    code_verifier: verifier,
    ...adapter.tokenExtras(st.requested_scopes),
  });
  if (exchanged.kind !== 'ok') {
    await auditFailure(deps, ctx, provider, 'exchange');
    throw exchangeFailed(provider);
  }
  const tokens = exchanged.tokens;
  let identity: { accountId: string; email: string };
  try {
    identity = await adapter.identity(
      deps.config,
      tokens.access_token,
      AbortSignal.timeout(OAUTH_LIMITS.providerTimeoutMs),
    );
  } catch {
    await auditFailure(deps, ctx, provider, 'identity');
    throw exchangeFailed(provider);
  }
  const scopes = grantedScopes(tokens, st.requested_scopes);
  const capabilities = capabilitiesFromScopes(provider, scopes);
  const requested = st.capabilities;
  if (!requested.some((c) => capabilities.includes(c))) {
    await auditFailure(deps, ctx, provider, 'scope');
    throw reasonError(
      'VALIDATION_FAILED',
      'None of the requested permissions was granted.',
      'OAUTH_SCOPE_NOT_GRANTED',
      { capabilities: requested.join(',') },
    );
  }

  // 4. Upsert the connection (same provider account), seal the tokens.
  const now = new Date();
  const saved = await withContext(deps.db, ctx, async (trx) => {
    const existing = await trx
      .selectFrom('connections')
      .selectAll()
      .where('user_id', '=', ctx.userId)
      .where('provider', '=', provider)
      .where('status', '<>', 'revoked')
      .forUpdate()
      .executeTakeFirst();
    if (st.connection_id && existing?.id !== st.connection_id) throw stateInvalid();
    if (existing?.provider_account_id && existing.provider_account_id !== identity.accountId) {
      await audit(trx, {
        tenantId: ctx.tenantId,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'connection.oauth_account_mismatch',
        targetType: 'connection',
        targetId: existing.id,
        metadata: { provider },
      });
      return { kind: 'mismatch' as const };
    }
    let refreshToken = tokens.refresh_token ?? null;
    if (!refreshToken && existing?.secret_ciphertext) {
      try {
        refreshToken = openTokens(deps.secrets, existing).refreshToken;
      } catch {
        refreshToken = null;
      }
    }
    const set: TokenSet = {
      accessToken: tokens.access_token,
      refreshToken,
      expiresAt: expiresAtOf(tokens, now.getTime()).toISOString(),
      scope: scopes,
      tokenType: tokens.token_type ?? 'Bearer',
    };
    const values = {
      label: PROVIDER_NAME[provider],
      account_identifier: identity.email,
      permissions: capabilities,
      status: 'active' as const,
      status_reason: null,
      config: '{}',
      capabilities,
      granted_scopes: scopes.slice(0, 32),
      provider_account_id: identity.accountId,
      token_expires_at: new Date(set.expiresAt),
      token_refreshed_at: now,
      last_verified_at: now,
      last_error: null,
      expires_at: null,
    };
    let row: ConnectionRow;
    let change: 'created' | 'reconnected' | 'capabilities';
    if (existing) {
      change = existing.status === 'active' ? 'capabilities' : 'reconnected';
      row = await trx
        .updateTable('connections')
        .set({ ...values, ...sealTokens(deps.secrets, existing, set) })
        .where('id', '=', existing.id)
        .returningAll()
        .executeTakeFirstOrThrow();
    } else {
      change = 'created';
      const id = randomUUID();
      try {
        row = await trx
          .insertInto('connections')
          .values({
            id,
            tenant_id: ctx.tenantId,
            user_id: ctx.userId,
            provider,
            ...values,
            ...sealTokens(deps.secrets, { id, user_id: ctx.userId, provider }, set),
          })
          .returningAll()
          .executeTakeFirstOrThrow();
      } catch (err) {
        if (isUniqueViolation(err))
          throw new AppError(
            'CONFLICT',
            'Another sign-in for this provider finished at the same time. Try again.',
          );
        throw err;
      }
    }
    // The user just granted this account again: a revocation still queued from an earlier
    // disconnect of the same account would revoke this new grant too (Google revokes per grant),
    // so it is cancelled. Other accounts' revocations stay queued (migration 0007).
    await sql`SELECT oauth_revocations_cancel(${provider}, ${identity.accountId})`.execute(trx);
    await appendEvent(trx, ctx, {
      taskId: null,
      type: 'connection.changed',
      data: { connectionId: row.id, provider, status: 'active', statusReason: null, change },
    });
    await audit(trx, {
      tenantId: ctx.tenantId,
      actorType: 'user',
      actorId: ctx.userId,
      action: 'connection.connected',
      targetType: 'connection',
      targetId: row.id,
      metadata: { provider, capabilities, change },
    });
    // Tasks that failed because this connection had expired, newest first.
    const since = new Date(now.getTime() - OAUTH_LIMITS.resumableWithinDays * 86_400_000);
    const resumable = await trx
      .selectFrom('tasks')
      .select(['id'])
      .where('status', '=', 'FAILED')
      .where(sql<boolean>`error->>'reason' = 'CONNECTION_EXPIRED'`)
      .where(sql<boolean>`error->'params'->>'provider' = ${provider}`)
      .where('updated_at', '>=', since)
      .orderBy('updated_at', 'desc')
      .orderBy('id', 'desc')
      .limit(OAUTH_LIMITS.resumableTasksMax)
      .execute();
    return { kind: 'ok' as const, row, resumable: resumable.map((r) => r.id) };
  });
  if (saved.kind === 'mismatch')
    throw reasonError(
      'CONFLICT',
      'You signed in to a different account than the one connected. Disconnect it first to switch accounts.',
      'OAUTH_ACCOUNT_MISMATCH',
      { provider },
    );
  connectionChanged(saved.row.id);
  return {
    connection: connectionView(saved.row),
    returnTo: st.return_to,
    resumableTaskIds: saved.resumable,
  };
}

const exchangeFailed = (provider: OAuthProvider) =>
  reasonError(
    'CONNECTION_FAILED',
    `${PROVIDER_NAME[provider]} did not accept the sign-in. Start again.`,
    'OAUTH_EXCHANGE_FAILED',
    { provider },
  );

async function auditFailure(
  deps: IntegrationDeps,
  ctx: RequestContext,
  provider: OAuthProvider,
  stage: string,
): Promise<void> {
  await withContext(deps.db, ctx, (trx) =>
    audit(trx, {
      tenantId: ctx.tenantId,
      actorType: 'user',
      actorId: ctx.userId,
      action: 'connection.oauth_failed',
      targetType: 'connection',
      metadata: { provider, stage },
    }),
  );
}

export { normalizeScope };
