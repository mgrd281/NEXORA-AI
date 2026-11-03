import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { withContext } from '../../db/pool';
import { AppError } from '../../lib/errors';
import { defineRoute } from '../../http/route';
import type { AppDeps } from '../../services';
import { loadMe } from '../account/me';
import { audit } from '../audit/audit';
import { burnPasswordCheck, verifyPassword } from './password';
import { createSession, SESSION_COOKIE } from './sessions';

export function registerAuthRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db, config } = deps;

  defineRoute(
    app,
    deps,
    'login',
    async ({ body, req, reply }) => {
      const found = await sql<{
        user_id: string;
        tenant_id: string;
        password_hash: string;
        status: string;
      }>`
        select * from auth_find_login(${body.email})`.execute(db);
      const row = found.rows[0];
      const ok = row
        ? await verifyPassword(row.password_hash, body.password)
        : (await burnPasswordCheck(body.password), false);
      if (!row || !ok || row.status !== 'active') {
        await audit(db, {
          tenantId: row?.tenant_id ?? null,
          actorType: 'user',
          actorId: row?.user_id ?? null,
          action: 'auth.login_failed',
          metadata: { platform: body.platform },
        });
        throw new AppError('UNAUTHENTICATED', 'Email or password is incorrect');
      }
      const ctx = { tenantId: row.tenant_id, userId: row.user_id };
      const { session, me } = await withContext(db, ctx, async (trx) => {
        const session = await createSession(trx, {
          ...ctx,
          platform: body.platform,
          deviceName: body.deviceName ?? null,
          userAgent: req.headers['user-agent'] ?? null,
          ttlDays: config.SESSION_TTL_DAYS,
        });
        await trx
          .updateTable('users')
          .set({ last_active_at: new Date() })
          .where('id', '=', row.user_id)
          .execute();
        await audit(trx, {
          ...ctx,
          actorType: 'user',
          actorId: row.user_id,
          action: 'auth.login',
          targetType: 'session',
          targetId: session.id,
          metadata: { platform: body.platform },
        });
        return { session, me: await loadMe(trx, row.user_id) };
      });
      if (body.platform === 'web') {
        reply.setCookie(SESSION_COOKIE, session.token, {
          httpOnly: true,
          secure: config.isProduction,
          sameSite: 'lax',
          path: '/',
          expires: session.expiresAt,
        });
      }
      return {
        user: me,
        session: { id: session.id, expiresAt: session.expiresAt.toISOString() },
        ...(body.platform !== 'web' ? { token: session.token } : {}),
      };
    },
    { rateLimit: { max: 10, timeWindow: '1 minute' } },
  );

  defineRoute(app, deps, 'logout', async ({ ctx, reply }) => {
    await withContext(db, ctx, async (trx) => {
      await trx
        .updateTable('sessions')
        .set({ revoked_at: new Date() })
        .where('id', '=', ctx.sessionId)
        .execute();
      await audit(trx, {
        tenantId: ctx.tenantId,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'auth.logout',
        targetType: 'session',
        targetId: ctx.sessionId,
      });
    });
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
  });

  defineRoute(app, deps, 'listSessions', async ({ ctx }) => {
    const rows = await withContext(db, ctx, (trx) =>
      trx
        .selectFrom('sessions')
        .selectAll()
        .where('revoked_at', 'is', null)
        .where('expires_at', '>', new Date())
        .orderBy('last_used_at', 'desc')
        .execute(),
    );
    return {
      items: rows.map((s) => ({
        id: s.id,
        deviceName: s.device_name,
        platform: s.platform,
        userAgent: s.user_agent,
        createdAt: s.created_at.toISOString(),
        lastUsedAt: s.last_used_at.toISOString(),
        expiresAt: new Date(s.expires_at).toISOString(),
        current: s.id === ctx.sessionId,
      })),
    };
  });

  defineRoute(app, deps, 'revokeSession', async ({ ctx, params }) => {
    await withContext(db, ctx, async (trx) => {
      const res = await trx
        .updateTable('sessions')
        .set({ revoked_at: new Date() })
        .where('id', '=', params.id)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      if (Number(res.numUpdatedRows) === 0) throw new AppError('NOT_FOUND', 'Session not found');
      await audit(trx, {
        tenantId: ctx.tenantId,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'auth.session_revoked',
        targetType: 'session',
        targetId: params.id,
      });
    });
  });
}
