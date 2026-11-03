import type { FastifyInstance } from 'fastify';
import { Preferences, type UpdateMeRequest } from '@jarvis/contracts';
import { withContext } from '../../db/pool';
import { defineRoute } from '../../http/route';
import { AppError, notFound } from '../../lib/errors';
import type { AppDeps } from '../../services';
import { audit } from '../audit/audit';
import { verifyPassword } from '../auth/password';
import { SESSION_COOKIE } from '../auth/sessions';
import { buildAccountExport } from './export';
import { loadMe, resolvePreferences } from './me';

const KNOWN_ZONES = new Set(Intl.supportedValuesOf('timeZone'));

/**
 * IANA zones known to the runtime. Intl.supportedValuesOf lists canonical
 * names only (it omits "UTC" and aliases such as Asia/Kolkata on some ICU
 * builds), so well-formed names Intl can actually format with are accepted too.
 */
export function isValidTimeZone(tz: string): boolean {
  if (tz === 'UTC' || KNOWN_ZONES.has(tz)) return true;
  if (!/^[A-Za-z]+(?:[/_+-][A-Za-z0-9]+)*$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Overlays a partial preferences patch (one level of groups) onto the resolved preferences. */
export function mergePreferences(
  current: Preferences,
  patch: NonNullable<UpdateMeRequest['preferences']>,
): Preferences {
  const next: Record<string, Record<string, unknown>> = { ...current };
  for (const [group, values] of Object.entries(patch)) {
    if (!values || !(group in current)) continue;
    const defined = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined));
    next[group] = { ...current[group as keyof Preferences], ...defined };
  }
  return Preferences.parse(next);
}

export function registerAccountRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps;

  defineRoute(app, deps, 'getMe', async ({ ctx }) =>
    withContext(db, ctx, (trx) => loadMe(trx, ctx.userId)),
  );

  defineRoute(app, deps, 'updateMe', async ({ ctx, body }) => {
    if (body.timeZone !== undefined && !isValidTimeZone(body.timeZone)) {
      throw new AppError('VALIDATION_FAILED', 'Unknown time zone', {
        issues: [{ path: 'timeZone', message: 'Unknown time zone' }],
      });
    }
    return withContext(db, ctx, async (trx) => {
      const user = await trx
        .selectFrom('users')
        .select('preferences')
        .where('id', '=', ctx.userId)
        .forUpdate()
        .executeTakeFirst();
      if (!user) throw notFound('User');

      const changed: string[] = [];
      const set: {
        display_name?: string;
        locale?: 'en' | 'de' | 'ar';
        time_zone?: string;
        theme?: 'system' | 'light' | 'dark';
        preferences?: string;
      } = {};
      if (body.displayName !== undefined) {
        set.display_name = body.displayName;
        changed.push('displayName');
      }
      if (body.locale !== undefined) {
        set.locale = body.locale;
        changed.push('locale');
      }
      if (body.timeZone !== undefined) {
        set.time_zone = body.timeZone;
        changed.push('timeZone');
      }
      if (body.theme !== undefined) {
        set.theme = body.theme;
        changed.push('theme');
      }
      if (body.preferences !== undefined) {
        const merged = mergePreferences(resolvePreferences(user.preferences), body.preferences);
        set.preferences = JSON.stringify(merged);
        for (const group of Object.keys(body.preferences)) changed.push(`preferences.${group}`);
      }
      if (changed.length > 0) {
        await trx.updateTable('users').set(set).where('id', '=', ctx.userId).execute();
        await audit(trx, {
          tenantId: ctx.tenantId,
          actorType: 'user',
          actorId: ctx.userId,
          action: 'account.updated',
          targetType: 'user',
          targetId: ctx.userId,
          metadata: { fields: changed },
        });
      }
      return loadMe(trx, ctx.userId);
    });
  });

  defineRoute(
    app,
    deps,
    'exportAccount',
    async ({ ctx, reply }) => {
      const now = new Date();
      const doc = await withContext(db, ctx, async (trx) => {
        const exported = await buildAccountExport(trx, ctx.userId, now);
        await audit(trx, {
          tenantId: ctx.tenantId,
          actorType: 'user',
          actorId: ctx.userId,
          action: 'account.exported',
          targetType: 'user',
          targetId: ctx.userId,
        });
        return exported;
      });
      reply.header(
        'content-disposition',
        `attachment; filename="jarvis-export-${now.toISOString().slice(0, 10)}.json"`,
      );
      reply.header('cache-control', 'no-store');
      return doc;
    },
    { rateLimit: { max: 5, timeWindow: '1 minute' } },
  );

  defineRoute(
    app,
    deps,
    'deleteAccount',
    async ({ ctx, body, reply }) => {
      const user = await withContext(db, ctx, (trx) =>
        trx
          .selectFrom('users')
          .select('password_hash')
          .where('id', '=', ctx.userId)
          .executeTakeFirst(),
      );
      if (!user) throw notFound('User');
      if (!(await verifyPassword(user.password_hash, body.password))) {
        await audit(db, {
          tenantId: ctx.tenantId,
          actorType: 'user',
          actorId: ctx.userId,
          action: 'account.delete_failed',
          targetType: 'user',
          targetId: ctx.userId,
          metadata: { reason: 'password' },
        });
        // Not 401: the session is valid; only the confirmation password is wrong.
        throw new AppError('FORBIDDEN', 'The password is incorrect.');
      }

      await withContext(db, ctx, async (trx) => {
        // The audit record is written first and commits atomically with the deletion.
        await audit(trx, {
          tenantId: ctx.tenantId,
          actorType: 'user',
          actorId: ctx.userId,
          action: 'account.deleted',
          targetType: 'user',
          targetId: ctx.userId,
        });
        // Cascades to every user-owned row (sessions, tasks, memories, connections, …).
        await trx.deleteFrom('users').where('id', '=', ctx.userId).execute();
        // Queued work for the user has no foreign key; drop it so the worker never runs it.
        await trx.deleteFrom('jobs').where('user_id', '=', ctx.userId).execute();
        const remaining = await trx
          .selectFrom('users')
          .select((eb) => eb.fn.countAll<number>().as('n'))
          .where('tenant_id', '=', ctx.tenantId)
          .executeTakeFirstOrThrow();
        if (Number(remaining.n) === 0) {
          await trx.deleteFrom('tenants').where('id', '=', ctx.tenantId).execute();
          await audit(trx, {
            tenantId: ctx.tenantId,
            actorType: 'user',
            actorId: ctx.userId,
            action: 'tenant.deleted',
            targetType: 'tenant',
            targetId: ctx.tenantId,
          });
        }
      });
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
    },
    // Password confirmation: limit guessing with a stolen session.
    { rateLimit: { max: 5, timeWindow: '15 minutes' } },
  );
}
