import type { FastifyInstance } from 'fastify';
import { Preferences, type UpdateMeRequest } from '@jarvis/contracts';
import { withContext } from '../../db/pool';
import { defineRoute } from '../../http/route';
import { AppError, notFound } from '../../lib/errors';
import { canonicalTimeZone } from '../../lib/period';
import type { AppDeps } from '../../services';
import { audit } from '../audit/audit';
import { verifyPassword } from '../auth/password';
import { SESSION_COOKIE } from '../auth/sessions';
import { deleteObjectsNow } from '../attachments/routes';
import { buildAccountExport, embedExportFiles, exportFileLocations } from './export';
import { loadMe, resolvePreferences } from './me';

// Kept for importers of the old location; the rule lives with the zone helpers now.
export { isValidTimeZone } from '../../lib/period';

const unknownTimeZone = () =>
  new AppError('VALIDATION_FAILED', 'Unknown time zone', {
    issues: [{ path: 'timeZone', message: 'Unknown time zone' }],
  });

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
    return withContext(db, ctx, async (trx) => {
      // Only zones both Node and Postgres understand, stored as Postgres spells them.
      const timeZone =
        body.timeZone === undefined ? undefined : await canonicalTimeZone(trx, body.timeZone);
      if (timeZone === null) throw unknownTimeZone();
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
      if (timeZone !== undefined) {
        set.time_zone = timeZone;
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
    async ({ ctx, req, reply }) => {
      const now = new Date();
      const { doc, files } = await withContext(db, ctx, async (trx) => {
        const exported = await buildAccountExport(trx, ctx.userId, now);
        const locations = await exportFileLocations(trx, ctx.userId);
        await audit(trx, {
          tenantId: ctx.tenantId,
          actorType: 'user',
          actorId: ctx.userId,
          action: 'account.exported',
          targetType: 'user',
          targetId: ctx.userId,
        });
        return { doc: exported, files: locations };
      });
      // Files are read from storage after the transaction (no connection held during I/O).
      await embedExportFiles(doc, files, deps.storage, req.log);
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
    async ({ ctx, body, req, reply }) => {
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

      const storedFiles = await withContext(db, ctx, async (trx) => {
        // Stored files: the attachments trigger queues each for deletion (storage_deletions,
        // drained by the worker); they are also deleted right after the commit below.
        const files = await trx
          .selectFrom('attachments')
          .select(['storage_key', 'storage_driver'])
          .where('user_id', '=', ctx.userId)
          .execute();
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
        return files;
      });
      await deleteObjectsNow(deps, storedFiles, req.log);
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
    },
    // Password confirmation: limit guessing with a stolen session.
    { rateLimit: { max: 5, timeWindow: '15 minutes' } },
  );
}
