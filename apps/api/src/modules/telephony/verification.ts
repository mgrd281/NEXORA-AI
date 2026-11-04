/**
 * Verifying the account's own phone number by a call that reads a code
 * (docs/architecture/phase-d.md §3.4). Only a verified number can receive transfers.
 *
 * start:   telephony configured (503 TELEPHONY_NOT_CONFIGURED), a number on the account (409
 *          PHONE_NUMBER_REQUIRED), not verified yet (409 PHONE_ALREADY_VERIFIED), a destination
 *          this server calls (400 CALL_DESTINATION_BLOCKED), at most
 *          CALL_LIMITS.verificationMaxPerDay per day and within the daily call limit (429
 *          PHONE_VERIFICATION_LIMIT); a live verification is replaced. The 6-digit code is sealed
 *          (SecretBox, AAD phone-verification:<user>:<id>); the row is committed before the
 *          provider is asked; the voice webhook reads the code twice.
 * current: the latest verification while it can be confirmed or shows why it failed (GET).
 * confirm: constant-time compare; at most verificationMaxAttempts (400 PHONE_VERIFICATION_INVALID
 *          { attemptsLeft }, then expired); verificationTtlMinutes (400
 *          PHONE_VERIFICATION_EXPIRED); the number unchanged since → users.phone_verified_at.
 */
import { randomInt, randomUUID } from 'node:crypto';
import {
  CALL_LIMITS,
  type Locale,
  type Me,
  type PhoneVerification,
  type PhoneVerificationState,
} from '@jarvis/contracts';
import { sql } from 'kysely';
import { withContext, type DbContext, type Trx } from '../../db/pool';
import type { PhoneVerificationRow } from '../../db/types';
import type { DefineTelephonyWebhook } from '../../http/webhook-route';
import { generateToken, safeEqual, sha256 } from '../../lib/crypto';
import { AppError } from '../../lib/errors';
import { currentDay, effectiveTimeZone } from '../../lib/period';
import { checkDestination } from '../../lib/phone';
import type { AppDeps } from '../../services';
import { loadMe } from '../account/me';
import { asLocale } from '../agent/i18n';
import { audit } from '../audit/audit';
import { appendEvent } from '../events/events';
import { TERMINAL } from './calls';
import { createTelephonyGateway } from './gateway';
import { toPhoneVerification, VERIFICATION_COLUMNS } from './mappers';
import * as twiml from './twilio/twiml';

export const codeAad = (userId: string, id: string) => `phone-verification:${userId}:${id}`;

const LIVE = ['calling', 'pending'] as const;

const fail = (
  code: ConstructorParameters<typeof AppError>[0],
  message: string,
  details: Record<string, unknown>,
) => new AppError(code, message, details);

async function changed(trx: Trx, ctx: DbContext, row: Pick<PhoneVerificationRow, 'id' | 'status'>) {
  await appendEvent(trx, ctx, {
    taskId: null,
    type: 'phone_verification.changed',
    data: { verificationId: row.id, status: row.status },
  });
}

/** What JARVIS reads on the verification call (the user's language; German "du"). */
export function verificationLine(lang: Locale, code: string): string {
  const d = code.split('').join(', ');
  switch (lang) {
    case 'de':
      return `Hallo, hier ist JARVIS, dein KI-Assistent. Dein Bestätigungscode lautet ${d}. Noch einmal: ${d}. Tschüss.`;
    case 'ar':
      return `مرحبًا، معك JARVIS، مساعدك الذكي. رمز التحقق الخاص بك هو ${d}. مرة أخرى: ${d}. مع السلامة.`;
    default:
      return `Hello, this is JARVIS, your AI assistant. Your verification code is ${d}. Again: ${d}. Goodbye.`;
  }
}

export async function startPhoneVerification(
  deps: AppDeps,
  ctx: DbContext,
): Promise<PhoneVerification> {
  const gw = createTelephonyGateway(deps.config);
  const t = deps.config.telephony;
  if (!gw || !t)
    throw fail('SERVICE_UNAVAILABLE', 'Phone calls are not configured on this server', {
      reason: 'TELEPHONY_NOT_CONFIGURED',
    });
  const token = generateToken();
  const code = String(randomInt(0, 10 ** CALL_LIMITS.verificationCodeLength)).padStart(
    CALL_LIMITS.verificationCodeLength,
    '0',
  );
  const created = await withContext(deps.db, ctx, async (trx) => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`calls:${ctx.userId}`}, 0))`.execute(
      trx,
    );
    const me = await loadMe(trx, ctx.userId);
    if (!me.phoneNumber)
      throw fail('CONFLICT', 'Add a phone number first', { reason: 'PHONE_NUMBER_REQUIRED' });
    if (me.phoneNumberVerifiedAt)
      throw fail('CONFLICT', 'This number is verified already', {
        reason: 'PHONE_ALREADY_VERIFIED',
      });
    const destination = checkDestination(me.phoneNumber, t.allowedCountries);
    if (!destination.ok)
      throw fail('VALIDATION_FAILED', 'JARVIS cannot call this number', {
        reason: 'CALL_DESTINATION_BLOCKED',
        country: destination.country ?? '',
      });
    const zone = await effectiveTimeZone(trx, me.timeZone);
    const { start } = await currentDay(trx, zone);
    const [verifications, calls] = await Promise.all([
      trx
        .selectFrom('phone_verifications')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('created_at', '>=', start)
        .executeTakeFirstOrThrow(),
      trx
        .selectFrom('call_sessions')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('created_at', '>=', start)
        .executeTakeFirstOrThrow(),
    ]);
    if (Number(verifications.n) >= CALL_LIMITS.verificationMaxPerDay)
      throw fail('RATE_LIMITED', 'Too many verification calls today', {
        reason: 'PHONE_VERIFICATION_LIMIT',
        max: CALL_LIMITS.verificationMaxPerDay,
      });
    // Verification calls count with the daily call limit.
    if (Number(verifications.n) + Number(calls.n) >= t.maxCallsPerDay)
      throw fail('RATE_LIMITED', 'Too many calls today', {
        reason: 'PHONE_VERIFICATION_LIMIT',
        max: t.maxCallsPerDay,
      });
    // One live verification: a new one replaces it.
    const replaced = await trx
      .updateTable('phone_verifications')
      .set({ status: 'expired' })
      .where('status', 'in', [...LIVE])
      .returning(['id', 'status'])
      .execute();
    for (const r of replaced) await changed(trx, ctx, r);
    const id = randomUUID();
    const now = new Date();
    const row = await trx
      .insertInto('phone_verifications')
      .values({
        id,
        tenant_id: ctx.tenantId,
        user_id: ctx.userId,
        phone_number: me.phoneNumber,
        code_ciphertext: deps.secrets.seal(code, codeAad(ctx.userId, id)),
        code_key_id: deps.secrets.keyId,
        webhook_token_hash: sha256(token),
        created_at: now,
        expires_at: new Date(now.getTime() + CALL_LIMITS.verificationTtlMinutes * 60_000),
      })
      .returning(VERIFICATION_COLUMNS)
      .executeTakeFirstOrThrow();
    await changed(trx, ctx, row);
    await audit(trx, {
      tenantId: ctx.tenantId,
      actorType: 'user',
      actorId: ctx.userId,
      action: 'phone_verification.started',
      targetType: 'phone_verification',
      targetId: id,
      metadata: {},
    });
    return row;
  });
  try {
    const call = await gw.createCall({
      to: created.phone_number,
      from: t.fromNumber,
      voiceUrl: gw.webhookUrl('twilioVerificationVoice', created.id, token),
      statusUrl: gw.webhookUrl('twilioVerificationStatus', created.id, token),
      amdUrl: null,
      ringTimeoutSeconds: CALL_LIMITS.ringTimeoutSeconds,
      timeLimitSeconds: 120,
    });
    const row = await withContext(deps.db, ctx, (trx) =>
      trx
        .updateTable('phone_verifications')
        .set({ provider_call_sid: call.sid })
        .where('id', '=', created.id)
        .where('provider_call_sid', 'is', null)
        .returning(VERIFICATION_COLUMNS)
        .executeTakeFirst(),
    );
    return toPhoneVerification(row ?? created);
  } catch (err) {
    await withContext(deps.db, ctx, async (trx) => {
      const r = await trx
        .updateTable('phone_verifications')
        .set({ status: 'failed' })
        .where('id', '=', created.id)
        .where('status', '=', 'calling')
        .where('provider_call_sid', 'is', null)
        .returning(['id', 'status'])
        .executeTakeFirst();
      if (r) await changed(trx, ctx, r);
    });
    throw fail(
      'SERVICE_UNAVAILABLE',
      'The verification call could not be placed. Try again later.',
      {
        provider: 'twilio',
        detail: String((err as Error).message ?? err).slice(0, 120),
      },
    );
  }
}

/**
 * GET /v1/me/phone/verification: the latest verification while it still matters — calling,
 * pending (the code field) or failed (why), before its expiry and for the number the account
 * has now — else null. Lets a client that left the screen or reloaded show the code field again.
 */
export async function currentPhoneVerification(
  deps: AppDeps,
  ctx: DbContext,
): Promise<PhoneVerificationState> {
  return withContext(deps.db, ctx, async (trx) => {
    const [v, user] = await Promise.all([
      trx
        .selectFrom('phone_verifications')
        .select(VERIFICATION_COLUMNS)
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(1)
        .executeTakeFirst(),
      trx
        .selectFrom('users')
        .select('phone_number')
        .where('id', '=', ctx.userId)
        .executeTakeFirstOrThrow(),
    ]);
    const now = new Date();
    if (
      !v ||
      !['calling', 'pending', 'failed'].includes(v.status) ||
      new Date(v.expires_at).getTime() <= now.getTime() ||
      v.phone_number !== user.phone_number
    )
      return { verification: null };
    return { verification: toPhoneVerification(v, now) };
  });
}

export async function confirmPhoneVerification(
  deps: AppDeps,
  ctx: DbContext,
  code: string,
): Promise<Me> {
  const result = await withContext(deps.db, ctx, async (trx) => {
    const v = await trx
      .selectFrom('phone_verifications')
      .selectAll()
      .where('status', 'in', [...LIVE])
      .orderBy('created_at', 'desc')
      .forUpdate()
      .executeTakeFirst();
    if (!v)
      return {
        error: fail('VALIDATION_FAILED', 'No verification is running', {
          reason: 'PHONE_VERIFICATION_INVALID',
          attemptsLeft: 0,
        }),
      };
    const expire = async () => {
      const r = await trx
        .updateTable('phone_verifications')
        .set({ status: 'expired' })
        .where('id', '=', v.id)
        .returning(['id', 'status'])
        .executeTakeFirstOrThrow();
      await changed(trx, ctx, r);
    };
    const expired = fail('VALIDATION_FAILED', 'The code has expired. Start a new verification.', {
      reason: 'PHONE_VERIFICATION_EXPIRED',
    });
    if (
      new Date(v.expires_at).getTime() <= Date.now() ||
      v.attempts >= CALL_LIMITS.verificationMaxAttempts
    ) {
      await expire();
      return { error: expired };
    }
    const user = await trx
      .selectFrom('users')
      .select('phone_number')
      .where('id', '=', ctx.userId)
      .executeTakeFirstOrThrow();
    if (user.phone_number !== v.phone_number) {
      await expire();
      return { error: expired };
    }
    let expected: string;
    try {
      expected = deps.secrets.open(v.code_ciphertext, codeAad(ctx.userId, v.id));
    } catch {
      await expire();
      return { error: expired };
    }
    if (!safeEqual(expected, code)) {
      const attempts = v.attempts + 1;
      const left = Math.max(0, CALL_LIMITS.verificationMaxAttempts - attempts);
      const r = await trx
        .updateTable('phone_verifications')
        .set({ attempts, ...(left === 0 ? { status: 'expired' as const } : {}) })
        .where('id', '=', v.id)
        .returning(['id', 'status'])
        .executeTakeFirstOrThrow();
      if (left === 0) await changed(trx, ctx, r);
      return {
        error: fail('VALIDATION_FAILED', 'The code is not correct', {
          reason: 'PHONE_VERIFICATION_INVALID',
          attemptsLeft: left,
        }),
      };
    }
    const now = new Date();
    const r = await trx
      .updateTable('phone_verifications')
      .set({ status: 'verified', verified_at: now, attempts: v.attempts + 1 })
      .where('id', '=', v.id)
      .returning(['id', 'status'])
      .executeTakeFirstOrThrow();
    await trx
      .updateTable('users')
      .set({ phone_verified_at: now })
      .where('id', '=', ctx.userId)
      .where('phone_number', '=', v.phone_number)
      .execute();
    await changed(trx, ctx, r);
    await audit(trx, {
      tenantId: ctx.tenantId,
      actorType: 'user',
      actorId: ctx.userId,
      action: 'phone_verification.verified',
      targetType: 'phone_verification',
      targetId: v.id,
      metadata: {},
    });
    return { me: await loadMe(trx, ctx.userId) };
  });
  if ('error' in result) throw result.error;
  return result.me;
}

/** The verification call's webhooks: read the code (twice), and its progress. */
export function registerVerificationWebhooks(deps: AppDeps, define: DefineTelephonyWebhook): void {
  const load = (ctx: DbContext, id: string) =>
    withContext(deps.db, ctx, (trx) =>
      trx.selectFrom('phone_verifications').selectAll().where('id', '=', id).executeTakeFirst(),
    );
  const mismatch = () =>
    new AppError('FORBIDDEN', 'This webhook does not belong to this call', {
      reason: 'WEBHOOK_SIGNATURE_INVALID',
    });

  define('twilioVerificationVoice', async ({ params, form, ctx }) => {
    const v = await load(ctx, params.verificationId);
    if (!v) throw new AppError('NOT_FOUND', 'Route not found');
    if (v.provider_call_sid && v.provider_call_sid !== form.CallSid) throw mismatch();
    const live =
      (v.status === 'calling' || v.status === 'pending') &&
      new Date(v.expires_at).getTime() > Date.now();
    if (!live) return { twiml: twiml.response(twiml.hangup()) };
    const out = await withContext(deps.db, ctx, async (trx) => {
      const r = await trx
        .updateTable('phone_verifications')
        .set({ status: 'pending', provider_call_sid: v.provider_call_sid ?? form.CallSid })
        .where('id', '=', v.id)
        .where('status', 'in', [...LIVE])
        .returning(['id', 'status', 'code_ciphertext'])
        .executeTakeFirst();
      if (!r) return null;
      if (v.status !== 'pending') await changed(trx, ctx, r);
      const me = await trx
        .selectFrom('users')
        .select('locale')
        .where('id', '=', ctx.userId)
        .executeTakeFirstOrThrow();
      return {
        code: deps.secrets.open(r.code_ciphertext, codeAad(ctx.userId, v.id)),
        lang: asLocale(me.locale),
      };
    });
    if (!out) return { twiml: twiml.response(twiml.hangup()) };
    return {
      twiml: twiml.response(
        twiml.pause(1),
        twiml.say(verificationLine(out.lang, out.code), out.lang),
        twiml.hangup(),
      ),
    };
  });

  define('twilioVerificationStatus', async ({ params, form, ctx }) => {
    const v = await load(ctx, params.verificationId);
    if (!v) throw new AppError('NOT_FOUND', 'Route not found');
    if (v.provider_call_sid && v.provider_call_sid !== form.CallSid) throw mismatch();
    if (!TERMINAL.has(form.CallStatus)) return { empty: true };
    // Busy, no answer, failed — or ended before the code was read: the verification failed.
    if (v.status === 'calling' || (v.status === 'pending' && form.CallStatus !== 'completed'))
      await withContext(deps.db, ctx, async (trx) => {
        const r = await trx
          .updateTable('phone_verifications')
          .set({ status: 'failed' })
          .where('id', '=', v.id)
          .where('status', 'in', [...LIVE])
          .returning(['id', 'status'])
          .executeTakeFirst();
        if (r) await changed(trx, ctx, r);
      });
    return { empty: true };
  });
}
