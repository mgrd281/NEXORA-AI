import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import type { Connection } from '@jarvis/contracts';
import { withContext } from '../../db/pool';
import type { ConnectionRow } from '../../db/types';
import { defineRoute } from '../../http/route';
import { AppError, notFound } from '../../lib/errors';
import type { AppDeps } from '../../services';
import { audit } from '../audit/audit';
import { appendEvent } from '../events/events';
import { integrations } from '../integrations';
import { connectionChanged } from '../integrations/bus';
import { openSecret, sealSecret, verifySmtp, type SmtpConfig, type SmtpSecret } from './smtp';

/** Columns that are safe to return. Secrets and provider config never leave the server. */
export const CONNECTION_COLUMNS = [
  'id',
  'provider',
  'label',
  'account_identifier',
  'status',
  'permissions',
  'last_verified_at',
  'last_error',
  'expires_at',
  'created_at',
  // Phase C (OAuth): what JARVIS may do with it; never the tokens or the provider account id.
  'capabilities',
  'granted_scopes',
  'status_reason',
] as const;

type PublicConnectionRow = Pick<ConnectionRow, (typeof CONNECTION_COLUMNS)[number]>;

const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);

export function toConnection(r: PublicConnectionRow): Connection {
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
    createdAt: r.created_at.toISOString(),
    capabilities: r.capabilities,
    scopes: r.granted_scopes,
    statusReason: r.status_reason,
  };
}

/** Shape of connections.config for SMTP rows (validated before use). */
const StoredSmtpConfig = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  security: z.enum(['tls', 'starttls', 'none']),
  username: z.string().optional(),
  fromAddress: z.string().min(1),
  fromName: z.string().optional(),
});

/**
 * Submission/relay ports. Other ports are refused so connection checks cannot
 * be used to probe arbitrary services; localhost (dev mailbox, tests) may use
 * any port when SMTP_ALLOW_INSECURE_LOCALHOST is set.
 */
export const SMTP_PORTS = new Set([25, 465, 587, 2525]);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

const OAUTH_PROVIDERS: ReadonlySet<string> = new Set(['google', 'microsoft']);

/**
 * OAuth start and callback: a few per minute per user is plenty for a person
 * (each start is one consent screen), and it bounds state churn.
 */
const OAUTH_RATE_LIMIT = { max: 10, timeWindow: '1 minute' } as const;

export function registerConnectionRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps;

  defineRoute(app, deps, 'listConnections', async ({ ctx }) => {
    const rows = await withContext(db, ctx, (trx) =>
      trx
        .selectFrom('connections')
        .select(CONNECTION_COLUMNS)
        .where('user_id', '=', ctx.userId)
        .where('status', '<>', 'revoked')
        .orderBy('created_at')
        .execute(),
    );
    return { items: rows.map(toConnection) };
  });

  defineRoute(
    app,
    deps,
    'connectSmtp',
    async ({ ctx, body }) => {
      const cfg: SmtpConfig = {
        host: body.host,
        port: body.port,
        security: body.security,
        fromAddress: body.fromAddress,
        ...(body.username ? { username: body.username } : {}),
        ...(body.fromName ? { fromName: body.fromName } : {}),
      };
      const secret: SmtpSecret = body.password ? { password: body.password } : {};

      const portAllowed =
        SMTP_PORTS.has(cfg.port) ||
        (deps.config.SMTP_ALLOW_INSECURE_LOCALHOST && LOCAL_HOSTS.has(cfg.host));
      // Verify before anything is stored: a connection that cannot authenticate is never saved.
      const verified = portAllowed
        ? await verifySmtp(cfg, secret, deps.config)
        : ({
            ok: false,
            error: 'Use a standard mail server port: 465 (TLS), 587 (STARTTLS), 25 or 2525.',
          } as const);
      if (!verified.ok) {
        await audit(db, {
          tenantId: ctx.tenantId,
          actorType: 'user',
          actorId: ctx.userId,
          action: 'connection.verify_failed',
          targetType: 'connection',
          metadata: { provider: 'smtp', host: cfg.host, port: cfg.port, security: cfg.security },
        });
        throw new AppError('CONNECTION_FAILED', verified.error);
      }

      const sealed = body.password
        ? sealSecret(deps.secrets, ctx.userId, 'smtp', secret)
        : { secret_ciphertext: null, secret_key_id: null };
      const values = {
        label: body.label,
        account_identifier: body.fromAddress,
        permissions: ['email.send'],
        status: 'active' as const,
        config: JSON.stringify(cfg),
        ...sealed,
        last_verified_at: new Date(),
        last_error: null,
        expires_at: null,
      };

      const row = await withContext(db, ctx, async (trx) => {
        const saved = await trx
          .insertInto('connections')
          .values({ tenant_id: ctx.tenantId, user_id: ctx.userId, provider: 'smtp', ...values })
          .onConflict((oc) =>
            oc
              .columns(['user_id', 'provider'])
              .where('status', '<>', 'revoked')
              .doUpdateSet(values),
          )
          .returning([...CONNECTION_COLUMNS, sql<boolean>`(xmax = 0)`.as('inserted')])
          .executeTakeFirstOrThrow();
        await audit(trx, {
          tenantId: ctx.tenantId,
          actorType: 'user',
          actorId: ctx.userId,
          action: 'connection.created',
          targetType: 'connection',
          targetId: saved.id,
          metadata: { provider: 'smtp', replaced: !saved.inserted },
        });
        await appendEvent(trx, ctx, {
          taskId: null,
          type: 'connection.changed',
          data: { connectionId: saved.id, provider: 'smtp', status: 'active' },
        });
        return saved;
      });
      return toConnection(row);
    },
    // Each attempt opens an outbound SMTP session; keep probing slow.
    { rateLimit: { max: 10, timeWindow: '1 minute' } },
  );

  defineRoute(app, deps, 'enableWebAccess', async ({ ctx }) => {
    const values = {
      label: 'Web access',
      account_identifier: null,
      permissions: ['web.fetch'],
      status: 'active' as const,
      config: '{}',
      secret_ciphertext: null,
      secret_key_id: null,
      last_verified_at: new Date(),
      last_error: null,
      expires_at: null,
    };
    const row = await withContext(db, ctx, async (trx) => {
      const saved = await trx
        .insertInto('connections')
        .values({ tenant_id: ctx.tenantId, user_id: ctx.userId, provider: 'web', ...values })
        .onConflict((oc) =>
          oc.columns(['user_id', 'provider']).where('status', '<>', 'revoked').doUpdateSet(values),
        )
        .returning([...CONNECTION_COLUMNS, sql<boolean>`(xmax = 0)`.as('inserted')])
        .executeTakeFirstOrThrow();
      await audit(trx, {
        tenantId: ctx.tenantId,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'connection.created',
        targetType: 'connection',
        targetId: saved.id,
        metadata: { provider: 'web', replaced: !saved.inserted },
      });
      await appendEvent(trx, ctx, {
        taskId: null,
        type: 'connection.changed',
        data: { connectionId: saved.id, provider: 'web', status: 'active' },
      });
      return saved;
    });
    return toConnection(row);
  });

  defineRoute(
    app,
    deps,
    'testConnection',
    async ({ ctx, params }) => {
      const current = await withContext(db, ctx, (trx) =>
        trx
          .selectFrom('connections')
          .select([...CONNECTION_COLUMNS, 'config', 'secret_ciphertext', 'user_id'])
          .where('id', '=', params.id)
          .where('status', '<>', 'revoked')
          .executeTakeFirst(),
      );
      if (!current) throw notFound('Connection');
      // OAuth (Phase C): tokens are opened only by the integrations module, which asks the
      // provider (identity endpoint with a valid token) — never "verified" without it. An
      // expired grant comes back as status 'expired' with its reason (Reconnect).
      if (OAUTH_PROVIDERS.has(current.provider))
        return toConnection(await integrations.verifyConnection(deps, ctx, current.id));

      // Network verification runs outside any transaction.
      let error: string | null = null;
      if (current.provider === 'smtp') {
        const cfg = StoredSmtpConfig.safeParse(current.config);
        let secret: SmtpSecret | null = null;
        try {
          secret = openSecret<SmtpSecret>(deps.secrets, current);
        } catch {
          error = 'Stored credentials could not be read. Reconnect this mailbox.';
        }
        if (!cfg.success) {
          error = 'Connection settings are incomplete. Reconnect this mailbox.';
        } else if (secret) {
          const verified = await verifySmtp(cfg.data, secret, deps.config);
          if (!verified.ok) error = verified.error;
        }
      }
      // Web access has no remote account: it works whenever it is enabled.

      const ok = error === null;
      const status = ok ? ('active' as const) : ('error' as const);
      const row = await withContext(db, ctx, async (trx) => {
        const updated = await trx
          .updateTable('connections')
          .set({
            status,
            last_error: error,
            ...(ok ? { last_verified_at: new Date() } : {}),
          })
          .where('id', '=', params.id)
          .where('status', '<>', 'revoked')
          .returning(CONNECTION_COLUMNS)
          .executeTakeFirst();
        if (!updated) throw notFound('Connection');
        await audit(trx, {
          tenantId: ctx.tenantId,
          actorType: 'user',
          actorId: ctx.userId,
          action: 'connection.tested',
          targetType: 'connection',
          targetId: updated.id,
          metadata: { provider: updated.provider, ok },
        });
        if (current.status !== status) {
          await appendEvent(trx, ctx, {
            taskId: null,
            type: 'connection.changed',
            data: { connectionId: updated.id, provider: updated.provider, status },
          });
        }
        return updated;
      });
      return toConnection(row);
    },
    { rateLimit: { max: 10, timeWindow: '1 minute' } },
  );

  defineRoute(app, deps, 'listConnectionProviders', async ({ reply }) => {
    reply.header('cache-control', 'private, no-store');
    return { items: integrations.providers(deps.config) };
  });

  defineRoute(
    app,
    deps,
    'startOAuthConnection',
    async ({ ctx, body, reply }) => {
      // The state, PKCE verifier and exact scopes are stored server-side (bound to this
      // session); the response is the provider URL to open. Errors (details.reason):
      // PROVIDER_NOT_CONFIGURED 503, REDIRECT_URI_NOT_ALLOWED / CONNECTION_NOT_OAUTH 400,
      // NOT_FOUND 404 (connectionId), OAUTH_PENDING_LIMIT 429.
      const started = await integrations.startOAuth(deps, ctx, body);
      // The URL carries the state: never cached anywhere.
      reply.header('cache-control', 'no-store');
      return started;
    },
    { rateLimit: OAUTH_RATE_LIMIT },
  );

  defineRoute(
    app,
    deps,
    'completeOAuthConnection',
    async ({ ctx, body, reply }) => {
      // Only the session that started the authorization can complete it (state bound to
      // ctx.sessionId, single use, expiring); the code is exchanged server-side with the
      // PKCE verifier. Errors (details.reason): OAUTH_STATE_INVALID / OAUTH_STATE_EXPIRED /
      // OAUTH_DENIED / OAUTH_SCOPE_NOT_GRANTED 400, OAUTH_ACCOUNT_MISMATCH 409,
      // OAUTH_EXCHANGE_FAILED 422, PROVIDER_NOT_CONFIGURED 503. Never a token in a response.
      const result = await integrations.completeOAuth(deps, ctx, body);
      reply.header('cache-control', 'no-store');
      return result;
    },
    { rateLimit: OAUTH_RATE_LIMIT },
  );

  defineRoute(app, deps, 'deleteConnection', async ({ ctx, params }) => {
    const removed = await withContext(db, ctx, async (trx) => {
      const current = await trx
        .selectFrom('connections')
        .select(['id', 'provider'])
        .where('id', '=', params.id)
        .where('status', '<>', 'revoked')
        .forUpdate()
        .executeTakeFirst();
      if (!current) throw notFound('Connection');

      let revocation: 'provider' | 'local_only' | null = null;
      if (OAUTH_PROVIDERS.has(current.provider)) {
        // OAuth (docs/adr/0016): the row is deleted, never kept as 'revoked' — its AFTER
        // DELETE trigger moves a Google envelope to the revocation outbox (the worker revokes
        // the grant at Google), and Microsoft tokens are erased with the row (Microsoft has no
        // per-app revocation endpoint). Email watches and pending authorizations cascade.
        await trx.deleteFrom('connections').where('id', '=', current.id).execute();
        revocation = current.provider === 'google' ? 'provider' : 'local_only';
      } else {
        // SMTP / web: revoke and erase — ciphertext, key id and every stored setting are wiped.
        await trx
          .updateTable('connections')
          .set({
            status: 'revoked',
            secret_ciphertext: null,
            secret_key_id: null,
            config: '{}',
            last_error: null,
          })
          .where('id', '=', current.id)
          .execute();
      }
      await audit(trx, {
        tenantId: ctx.tenantId,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'connection.deleted',
        targetType: 'connection',
        targetId: current.id,
        metadata: { provider: current.provider, ...(revocation ? { revocation } : {}) },
      });
      await appendEvent(trx, ctx, {
        taskId: null,
        type: 'connection.changed',
        data: {
          connectionId: current.id,
          provider: current.provider,
          status: 'revoked',
          ...(revocation ? { change: 'disconnected' } : {}),
        },
      });
      return current;
    });
    // In-memory caches (Home "Upcoming") drop what they hold for it.
    connectionChanged(removed.id);
  });
}
