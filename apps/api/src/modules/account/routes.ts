import type { FastifyInstance } from 'fastify';
import { Preferences, type UpdateMeRequest } from '@jarvis/contracts';
import { withContext } from '../../db/pool';
import { defineRoute } from '../../http/route';
import { AppError, notFound } from '../../lib/errors';
import { canonicalTimeZone } from '../../lib/period';
import { BLOCKED_NUMBER_TYPES, parsePhoneNumber } from '../../lib/phone';
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

/**
 * Phase C (docs/adr/0018): the monthly purchase limit is an amount of money,
 * so it is whole cents (the contract bounds it to 0…COMMERCE_LIMITS max). A
 * value like 10.005 would be compared in micro-USD and shown rounded —
 * refused instead of silently rounded.
 */
export function isWholeCents(amount: number): boolean {
  return Number.isFinite(amount) && Math.abs(Math.round(amount * 100) - amount * 100) < 1e-6;
}

const purchaseLimitNotCents = () =>
  new AppError('VALIDATION_FAILED', 'The purchase limit must be an amount in whole cents', {
    issues: [
      {
        path: 'preferences.spending.monthlyPurchaseLimitUsd',
        message: 'Use at most two decimal places',
      },
    ],
  });

/**
 * Phase D: the account's phone number as stored — E.164 of a valid number of a type JARVIS
 * would put a callee through to (never premium-rate / shared-cost …). The contract checks
 * the shape; this checks the number exists.
 */
export function profilePhoneNumber(raw: string): string {
  const parsed = parsePhoneNumber(raw);
  if (!parsed || parsed.e164 !== raw)
    throw new AppError('VALIDATION_FAILED', 'Not a valid phone number', {
      reason: 'PHONE_NUMBER_INVALID',
      issues: [{ path: 'phoneNumber', message: 'Not a valid phone number' }],
    });
  if (parsed.type && BLOCKED_NUMBER_TYPES.has(parsed.type))
    throw new AppError('VALIDATION_FAILED', 'JARVIS does not use numbers of this type', {
      reason: 'CALL_DESTINATION_BLOCKED',
      country: parsed.country ?? '',
      issues: [{ path: 'phoneNumber', message: 'Premium-rate and similar numbers are not allowed' }],
    });
  return parsed.e164;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Overlays a partial preferences patch onto the resolved preferences: per group, and one level
 * deeper for nested objects (Phase D voice.voiceNames: an omitted language keeps its voice).
 */
export function mergePreferences(
  current: Preferences,
  patch: NonNullable<UpdateMeRequest['preferences']>,
): Preferences {
  const next: Record<string, Record<string, unknown>> = { ...current };
  for (const [group, values] of Object.entries(patch)) {
    if (!values || !(group in current)) continue;
    const base = current[group as keyof Preferences] as Record<string, unknown>;
    const merged: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(values)) {
      if (v === undefined) continue;
      merged[k] =
        isPlainObject(v) && isPlainObject(base[k])
          ? {
              ...base[k],
              ...Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined)),
            }
          : v;
    }
    next[group] = merged;
  }
  return Preferences.parse(next);
}

export function registerAccountRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps;

  defineRoute(app, deps, 'getMe', async ({ ctx }) =>
    withContext(db, ctx, (trx) => loadMe(trx, ctx.userId)),
  );

  defineRoute(app, deps, 'updateMe', async ({ ctx, body }) => {
    const purchaseLimit = body.preferences?.spending?.monthlyPurchaseLimitUsd;
    if (purchaseLimit !== undefined && !isWholeCents(purchaseLimit)) throw purchaseLimitNotCents();
    return withContext(db, ctx, async (trx) => {
      // Only zones both Node and Postgres understand, stored as Postgres spells them.
      const timeZone =
        body.timeZone === undefined ? undefined : await canonicalTimeZone(trx, body.timeZone);
      if (timeZone === null) throw unknownTimeZone();
      const user = await trx
        .selectFrom('users')
        .select(['preferences', 'phone_number'])
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
        phone_number?: string | null;
        phone_verified_at?: Date | null;
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
      // Phase D: a new number (or none) is unverified until a verification call confirms it.
      if (body.phoneNumber !== undefined) {
        const next = body.phoneNumber === null ? null : profilePhoneNumber(body.phoneNumber);
        if (next !== user.phone_number) {
          set.phone_number = next;
          set.phone_verified_at = null;
          changed.push('phoneNumber');
        }
      }
      let purchaseLimitChanged = false;
      if (body.preferences !== undefined) {
        const current = resolvePreferences(user.preferences);
        const merged = mergePreferences(current, body.preferences);
        set.preferences = JSON.stringify(merged);
        for (const group of Object.keys(body.preferences)) changed.push(`preferences.${group}`);
        purchaseLimitChanged =
          merged.spending.monthlyPurchaseLimitUsd !== current.spending.monthlyPurchaseLimitUsd;
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
          // Whether the purchase limit changed, never the amounts (the policy reads the
          // current value; the history of what a user allowed is not kept elsewhere).
          metadata: { fields: changed, ...(purchaseLimitChanged ? { purchaseLimitChanged } : {}) },
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
        const files = [
          ...(await trx
            .selectFrom('attachments')
            .select(['storage_key', 'storage_driver'])
            .where('user_id', '=', ctx.userId)
            .execute()),
          // Phase C: the browser agent's evidence files (same trigger, same immediate delete).
          ...(await trx
            .selectFrom('evidence_artifacts')
            .select(['storage_key', 'storage_driver'])
            .where('user_id', '=', ctx.userId)
            .execute()),
        ];
        // The audit record is written first and commits atomically with the deletion.
        await audit(trx, {
          tenantId: ctx.tenantId,
          actorType: 'user',
          actorId: ctx.userId,
          action: 'account.deleted',
          targetType: 'user',
          targetId: ctx.userId,
        });
        // Cascades to every user-owned row (sessions, tasks, memories, connections, …). Phase C:
        // the connections' AFTER DELETE trigger queues Google grants for revocation at Google
        // (oauth_revocations, drained by the worker); orders, bookings, email watches, OAuth
        // states, browser sessions and evidence (storage deletion queued) cascade as well.
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
