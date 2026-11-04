/**
 * Placing a call attempt exactly once, and finding out what became of it
 * (docs/architecture/phase-d.md §3.2; ADR-0020).
 *
 * A step's latest attempt decides what an execution does:
 *   none, or ended unsuccessfully (busy, no answer, failed, voicemail, hung up — a retry the
 *     user asked for)                                   → insert attempt n + 1, then dial
 *   queued / dialing / ringing / in_progress            → never dial: wait for it
 *   completed / answered                                → reuse its outcome
 *   unknown (or queued without a provider id: an execution died while asking the provider)
 *                                                       → reconcile with the provider first
 * The attempt row (unique per step and attempt, and per idempotency key) is committed before
 * the provider is asked; a create request whose outcome is unknown leaves it 'unknown'.
 * Reconciliation adopts the call when a webhook of it arrived meanwhile (its URL names the
 * attempt) or the provider's call list shows exactly one matching call; only a provider that
 * lists no such call lets attempt n + 1 dial.
 */
import { CALL_LIMITS } from '@jarvis/contracts';
import { sql } from 'kysely';
import type { Config } from '../../config';
import { withContext, type Db, type DbContext, type Trx } from '../../db/pool';
import type { CallSessionRow } from '../../db/types';
import { currentDay, localTimeOfDay } from '../../lib/period';
import { maskPhoneNumber } from '../../lib/phone';
import { AgentError } from '../agent/errors';
import {
  adoptSid,
  advance,
  finalizeCall,
  insertAttempt,
  latestAttempt,
  lockCall,
  markNotPlaced,
  markUnknown,
  onBehalfOf,
  recordPrice,
  TERMINAL,
  watchdogDelaySeconds,
  type NewAttempt,
} from './calls';
import { isOnDoNotCall } from './do-not-call';
import type { ProviderCall, TelephonyGateway } from './gateway';
import { providerStepError, TelephonyError } from './twilio/errors';

export type AttemptPlan =
  | { kind: 'dial'; row: CallSessionRow; token: string }
  | { kind: 'wait'; row: CallSessionRow }
  | { kind: 'reuse'; row: CallSessionRow }
  | { kind: 'reconcile'; row: CallSessionRow };

const SUCCESS = new Set(['completed', 'answered']);

/** How old an unknown attempt must be before an empty provider call list proves it was not placed. */
export const RECONCILE_SETTLE_MS = 60_000;

export const deny = (
  reason: 'DO_NOT_CALL' | 'CALL_OUTSIDE_HOURS' | 'CALL_LIMIT',
  params: Record<string, string | number>,
) =>
  new AgentError('POLICY_DENIED', `The call is not allowed right now (${reason}).`, {
    retryable: reason !== 'DO_NOT_CALL',
    reason,
    params,
  });

/**
 * Right before dialling, in the attempt's transaction (serialised per user): the do-not-call
 * list, the calling hours of the callee's zone and the daily limit, again — the Policy Engine
 * decided on them when the step was prepared; this closes the gap to the dial itself.
 */
async function recheck(
  trx: Trx,
  config: Config,
  a: NewAttempt,
  timeZone: string,
  now: Date,
): Promise<void> {
  const t = config.telephony!;
  if (await isOnDoNotCall(trx, config, a.input.to))
    throw deny('DO_NOT_CALL', { number: maskPhoneNumber(a.input.to) });
  const zone = a.input.calleeTimeZone ?? timeZone;
  const local = localTimeOfDay(now, zone);
  if (local === null || !(local >= t.allowedHours.start && local < t.allowedHours.end))
    throw deny('CALL_OUTSIDE_HOURS', {
      start: t.allowedHours.start,
      end: t.allowedHours.end,
      timeZone: zone,
    });
  // The same count as the policy's (AgentContext.telephony.callsToday): attempts today.
  const { start } = await currentDay(trx, timeZone);
  const calls = await trx
    .selectFrom('call_sessions')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('created_at', '>=', start)
    .executeTakeFirstOrThrow();
  if (Number(calls.n) >= t.maxCallsPerDay) throw deny('CALL_LIMIT', { max: t.maxCallsPerDay });
}

/** What this execution of the step does (inserting attempt n + 1 when it dials). */
export async function planAttempt(
  db: Db,
  ctx: DbContext,
  config: Config,
  a: Omit<NewAttempt, 'attempt'>,
  timeZone: string,
  now = new Date(),
): Promise<AttemptPlan> {
  return withContext(db, ctx, async (trx) => {
    // One attempt decision at a time per user (the daily limit cannot be raced).
    await sql`select pg_advisory_xact_lock(hashtextextended(${`calls:${ctx.userId}`}, 0))`.execute(
      trx,
    );
    const latest = await latestAttempt(trx, a.stepId);
    if (latest) {
      if (latest.status === 'unknown' || (latest.status === 'queued' && !latest.provider_call_sid))
        return { kind: 'reconcile', row: latest };
      if (latest.status !== 'ended') return { kind: 'wait', row: latest };
      if (latest.result && SUCCESS.has(latest.result)) return { kind: 'reuse', row: latest };
      // Declined calls are never repeated automatically (the callee said no to this call).
      if (latest.result === 'declined') return { kind: 'reuse', row: latest };
    }
    const attempt = (latest?.attempt ?? 0) + 1;
    if (attempt > 20)
      throw new AgentError('TOOL_FAILED', 'This call was tried too often.', {
        retryable: false,
        reason: 'CALL_LIMIT',
        params: { max: 20 },
      });
    const full = { ...a, attempt };
    await recheck(trx, config, full, timeZone, now);
    const { row, token } = await insertAttempt(trx, ctx, config, full);
    return { kind: 'dial', row, token };
  });
}

/** Asks the provider to place the attempt's call (once). */
export async function dial(
  db: Db,
  ctx: DbContext,
  gw: TelephonyGateway,
  plan: Extract<AttemptPlan, { kind: 'dial' }>,
  signal?: AbortSignal,
): Promise<CallSessionRow> {
  const { row, token } = plan;
  let call: ProviderCall;
  try {
    call = await gw.createCall(
      {
        to: row.callee_number,
        from: row.caller_id,
        voiceUrl: gw.webhookUrl('twilioCallVoice', row.id, token),
        statusUrl: gw.webhookUrl('twilioCallStatus', row.id, token),
        amdUrl: gw.webhookUrl('twilioCallAmd', row.id, token),
        ringTimeoutSeconds: CALL_LIMITS.ringTimeoutSeconds,
        timeLimitSeconds: row.max_duration_seconds + 30,
      },
      signal,
    );
  } catch (err) {
    if (err instanceof TelephonyError && err.kind !== 'unknown') {
      await withContext(db, ctx, async (trx) => {
        const locked = await lockCall(trx, row.id);
        if (locked && !locked.provider_call_sid)
          await markNotPlaced(
            trx,
            ctx,
            locked,
            providerStepError(err).reason ?? 'PROVIDER_REJECTED',
          );
      });
      throw providerStepError(err);
    }
    // The request may have reached the provider: the call may exist.
    await withContext(db, ctx, async (trx) => {
      const locked = await lockCall(trx, row.id);
      if (locked && !locked.provider_call_sid) await markUnknown(trx, ctx, locked);
    });
    throw unknownOutcome();
  }
  return withContext(db, ctx, async (trx) => {
    const locked = (await lockCall(trx, row.id))!;
    // A webhook of this call may have adopted its id already (it arrived before this answer).
    return adoptSid(trx, ctx, locked, call.sid);
  });
}

export const unknownOutcome = () =>
  new AgentError(
    'OUTCOME_UNKNOWN',
    'The telephony provider did not confirm whether the call was placed. JARVIS will check with the provider before calling again.',
    { retryable: false, reason: 'CALL_STATE_UNKNOWN' },
  );

/** Applies a provider call record (fetched / listed) to the attempt: adopt, advance, end. */
export async function applyProviderCall(
  trx: Trx,
  ctx: DbContext,
  row: CallSessionRow,
  call: ProviderCall,
): Promise<CallSessionRow> {
  let r = await adoptSid(trx, ctx, row, call.sid);
  if (r.provider_call_sid !== call.sid) return r;
  if (TERMINAL.has(call.status)) {
    if (call.answeredBy && !r.answered_by) {
      const by = call.answeredBy.startsWith('machine')
        ? 'machine'
        : call.answeredBy === 'human'
          ? 'human'
          : call.answeredBy === 'fax'
            ? 'fax'
            : 'unknown';
      r = await trx
        .updateTable('call_sessions')
        .set({ answered_by: by })
        .where('id', '=', r.id)
        .returningAll()
        .executeTakeFirstOrThrow();
    }
    r = await finalizeCall(trx, ctx, r, await onBehalfOf(trx, r), {
      providerStatus: call.status as 'completed',
      durationSeconds: call.durationSeconds,
      failureDetail: call.status === 'failed' ? 'failed' : null,
    });
    return recordPrice(trx, ctx, r, call.price);
  }
  if (call.status === 'ringing')
    return advance(trx, ctx, r, 'ringing', { providerStatus: 'ringing', sequence: null });
  if (call.status === 'in-progress')
    return advance(trx, ctx, r, 'in_progress', { providerStatus: 'in-progress', sequence: null });
  return r;
}

/**
 * Reconciles an attempt whose provider state is unknown. Returns the attempt afterwards:
 * adopted (live or ended), definitely not placed (ended, failed), or still unknown.
 */
export async function reconcile(
  db: Db,
  ctx: DbContext,
  gw: TelephonyGateway,
  row: CallSessionRow,
): Promise<CallSessionRow> {
  if (row.provider_call_sid) {
    const call = await gw.fetchCall(row.provider_call_sid);
    return withContext(db, ctx, async (trx) =>
      applyProviderCall(trx, ctx, (await lockCall(trx, row.id))!, call),
    );
  }
  const since = new Date(new Date(row.created_at).getTime() - 60_000);
  const until = new Date(new Date(row.created_at).getTime() + 10 * 60_000);
  const listed = (await gw.findCalls({ to: row.callee_number, from: row.caller_id, since })).filter(
    (c) => !c.createdAt || (c.createdAt >= since && c.createdAt <= until),
  );
  return withContext(db, ctx, async (trx) => {
    const locked = (await lockCall(trx, row.id))!;
    if (locked.provider_call_sid) {
      // A webhook adopted it meanwhile.
      const call = listed.find((c) => c.sid === locked.provider_call_sid);
      return call ? applyProviderCall(trx, ctx, locked, call) : locked;
    }
    const known = listed.length
      ? await trx
          .selectFrom('call_sessions')
          .select('provider_call_sid')
          .where(
            'provider_call_sid',
            'in',
            listed.map((c) => c.sid),
          )
          .execute()
      : [];
    const taken = new Set(known.map((k) => k.provider_call_sid));
    const candidates = listed.filter((c) => !taken.has(c.sid));
    if (candidates.length === 0) {
      // The provider's call list can lag behind a just-created call: only an attempt old enough
      // counts as "not placed" (until then it stays unknown — the user retries a little later).
      if (Date.now() - new Date(locked.created_at).getTime() < RECONCILE_SETTLE_MS)
        return locked.status === 'queued' ? markUnknown(trx, ctx, locked) : locked;
      // The provider has no such call: nothing was placed — a new attempt may dial.
      return markNotPlaced(
        trx,
        ctx,
        locked.status === 'queued' ? await markUnknown(trx, ctx, locked) : locked,
        'CALL_FAILED',
      );
    }
    if (candidates.length > 1)
      return locked.status === 'queued' ? markUnknown(trx, ctx, locked) : locked;
    return applyProviderCall(trx, ctx, locked, candidates[0]!);
  });
}

/** When a step stops waiting for its call's webhooks and settles it with the provider itself. */
export function attemptDeadline(
  row: Pick<CallSessionRow, 'created_at' | 'max_duration_seconds'>,
): number {
  return (
    new Date(row.created_at).getTime() +
    (watchdogDelaySeconds(row.max_duration_seconds) - 30) * 1000
  );
}

/** Reads the attempt (RLS: the owner only). */
export async function readAttempt(db: Db, ctx: DbContext, id: string): Promise<CallSessionRow> {
  return withContext(db, ctx, (trx) =>
    trx.selectFrom('call_sessions').selectAll().where('id', '=', id).executeTakeFirstOrThrow(),
  );
}

/** The provider's final price of an ended call (fetched once; recorded once). */
export async function settlePrice(
  db: Db,
  ctx: DbContext,
  gw: TelephonyGateway,
  row: CallSessionRow,
): Promise<CallSessionRow> {
  if (row.status !== 'ended' || row.price_micro !== null || !row.provider_call_sid) return row;
  try {
    const call = await gw.fetchCall(row.provider_call_sid);
    if (!call.price) return row;
    return withContext(db, ctx, async (trx) =>
      recordPrice(trx, ctx, (await lockCall(trx, row.id))!, call.price),
    );
  } catch {
    return row;
  }
}

export type { Config };
