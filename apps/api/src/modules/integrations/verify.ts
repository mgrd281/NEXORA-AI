/**
 * POST /v1/connections/:id/test for an OAuth connection: re-verifies it with the
 * provider instead of assuming it works. A valid access token (refreshed under the
 * row lock when needed: invalid_grant → expired) is presented to the identity
 * endpoint (Google userinfo, Graph GET /me). 200 for the same account → verified
 * now; 401 → one forced refresh and one retry, then expired TOKEN_REJECTED (with the
 * usual single notification); a different account → expired GRANT_INVALID; the
 * provider not answering → SERVICE_UNAVAILABLE, nothing changed.
 */
import { withContext, type DbContext } from '../../db/pool';
import type { ConnectionRow } from '../../db/types';
import { AppError } from '../../lib/errors';
import { AgentError } from '../agent/errors';
import { audit } from '../audit/audit';
import { connectionChanged } from './bus';
import { OAUTH_ADAPTERS } from './oauth-client';
import { providerSignal } from './signal';
import { accessToken, markExpiredIn, markTokenRejected } from './tokens';
import { PROVIDER_NAME, isOAuthProvider, type IntegrationDeps } from './types';

const statusOf = (err: unknown): number | null => {
  const s = (err as { status?: unknown } | null)?.status;
  return typeof s === 'number' ? s : null;
};

async function readRow(
  deps: IntegrationDeps,
  ctx: DbContext,
  connectionId: string,
): Promise<ConnectionRow> {
  const row = await withContext(deps.db, ctx, (trx) =>
    trx.selectFrom('connections').selectAll().where('id', '=', connectionId).executeTakeFirst(),
  );
  if (!row) throw new AppError('NOT_FOUND', 'Connection not found');
  return row;
}

export async function verifyConnection(
  deps: IntegrationDeps,
  ctx: DbContext,
  connectionId: string,
): Promise<ConnectionRow> {
  const before = await readRow(deps, ctx, connectionId);
  if (!isOAuthProvider(before.provider))
    throw new AppError('VALIDATION_FAILED', 'Not an OAuth connection', {
      reason: 'CONNECTION_NOT_OAUTH',
    });
  const provider = before.provider;
  // Expired already: only reconnecting helps; the row says so.
  if (before.status !== 'active') return before;
  const adapter = OAUTH_ADAPTERS[provider];
  let token: string;
  try {
    ({ token } = await accessToken(deps, ctx, connectionId));
  } catch (err) {
    // invalid_grant / an unopenable envelope: the row is expired now (notified once).
    if (err instanceof AgentError && err.reason === 'CONNECTION_EXPIRED')
      return readRow(deps, ctx, connectionId);
    if (err instanceof AgentError && err.reason === 'PROVIDER_UNAVAILABLE')
      throw new AppError('SERVICE_UNAVAILABLE', `${PROVIDER_NAME[provider]} did not answer.`, {
        provider,
      });
    throw err;
  }
  let identity: { accountId: string; email: string } | null = null;
  for (let attempt = 1; attempt <= 2 && !identity; attempt++) {
    try {
      identity = await adapter.identity(deps.config, token, providerSignal());
    } catch (err) {
      if (statusOf(err) !== 401)
        throw new AppError('SERVICE_UNAVAILABLE', `${PROVIDER_NAME[provider]} did not answer.`, {
          provider,
        });
      if (attempt === 2) {
        await markTokenRejected(deps, ctx, connectionId);
        return readRow(deps, ctx, connectionId);
      }
      try {
        ({ token } = await accessToken(deps, ctx, connectionId, {
          forceRefresh: true,
          rejectedToken: token,
        }));
      } catch (refreshErr) {
        if (refreshErr instanceof AgentError && refreshErr.reason === 'CONNECTION_EXPIRED')
          return readRow(deps, ctx, connectionId);
        throw new AppError('SERVICE_UNAVAILABLE', `${PROVIDER_NAME[provider]} did not answer.`, {
          provider,
        });
      }
    }
  }
  return withContext(deps.db, ctx, async (trx) => {
    if (before.provider_account_id && identity!.accountId !== before.provider_account_id) {
      // The token answers for another account: never act on it.
      await markExpiredIn(trx, ctx, connectionId, 'GRANT_INVALID');
    } else {
      await trx
        .updateTable('connections')
        .set({ last_verified_at: new Date() })
        .where('id', '=', connectionId)
        .where('status', '=', 'active')
        .execute();
      connectionChanged(connectionId);
    }
    await audit(trx, {
      tenantId: ctx.tenantId,
      actorType: 'user',
      actorId: ctx.userId,
      action: 'connection.tested',
      targetType: 'connection',
      targetId: connectionId,
      metadata: { provider, ok: identity!.accountId === before.provider_account_id },
    });
    return trx
      .selectFrom('connections')
      .selectAll()
      .where('id', '=', connectionId)
      .executeTakeFirstOrThrow();
  });
}
