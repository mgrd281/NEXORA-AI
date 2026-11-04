/**
 * Call sessions — one row per call attempt (docs/architecture/phase-d.md §3.2, §7; ADR-0020).
 *
 * Exactly once per attempt: the row is inserted BEFORE the provider is asked, unique on
 * (user, idempotency key 'call:<step>:a<n>') and (step, attempt); a unique violation means
 * "this attempt exists — read it, never dial again". The provider call id is adopted once
 * (unique), the status only moves forward (queued → dialing → ringing → in_progress → ended),
 * an ended call is final, and its outcome is computed from the turns (dialog/state.ts).
 * Every change of status appends to the status timeline and emits call.status_changed;
 * every turn emits call.turn (ids only — clients refetch).
 */
import {
  CALL_LIMITS,
  TELEPHONY_WEBHOOK_LIMITS,
  type CallOutcome,
  type CallStatusEvent,
  type Locale,
  type ServerMessage,
} from '@jarvis/contracts';
import { sql, type Updateable } from 'kysely';
import type { Config } from '../../config';
import type { DbContext, Trx } from '../../db/pool';
import type { CallSessionRow, CallSessionsTable, CallStatusValue } from '../../db/types';
import { generateToken, sha256 } from '../../lib/crypto';
import { parsePhoneNumber, phoneHashKey, phoneNumberHash } from '../../lib/phone';
import { msg } from '../agent/i18n';
import { appendEvent } from '../events/events';
import { enqueue } from '../jobs/queue';
import {
  computeOutcome,
  type ApprovedCall,
  type OutcomeFacts,
  type TurnView,
} from './dialog/state';

/** Twilio's terminal statuses. */
export const TERMINAL = new Set(['completed', 'busy', 'failed', 'no-answer', 'canceled']);
/** Attempts that may still be running at the provider. */
export const LIVE: ReadonlySet<CallStatusValue> = new Set([
  'queued',
  'dialing',
  'ringing',
  'in_progress',
]);
const RANK: Record<CallStatusValue, number> = {
  queued: 0,
  unknown: 0,
  dialing: 1,
  ringing: 2,
  in_progress: 3,
  ended: 4,
};

export const callIdempotencyKey = (stepId: string, attempt: number) => `call:${stepId}:a${attempt}`;

/** When the watchdog looks at a call: ring timeout + its maximum duration + a margin. */
export function watchdogDelaySeconds(maxDurationSeconds: number): number {
  return CALL_LIMITS.ringTimeoutSeconds + maxDurationSeconds + CALL_LIMITS.transferRingSeconds + 60;
}

/** The callee as the result line names them: the user's words, else the number for reading. */
export function calleeLabel(input: { calleeName: string | null; to: string }): string {
  return input.calleeName ?? parsePhoneNumber(input.to)?.international ?? input.to;
}

const hashKeys = new Map<string, Buffer>();
export function numberHash(config: Pick<Config, 'SECRET_ENCRYPTION_KEY'>, e164: string): Buffer {
  let key = hashKeys.get(config.SECRET_ENCRYPTION_KEY);
  if (!key) {
    key = phoneHashKey(config.SECRET_ENCRYPTION_KEY);
    hashKeys.set(config.SECRET_ENCRYPTION_KEY, key);
  }
  return phoneNumberHash(key, e164);
}

export async function callChanged(trx: Trx, ctx: DbContext, row: CallSessionRow): Promise<void> {
  await appendEvent(trx, ctx, {
    taskId: row.task_id,
    type: 'call.status_changed',
    data: {
      callId: row.id,
      taskId: row.task_id,
      stepId: row.step_id,
      status: row.status,
      result: row.result,
    },
  });
}

export async function latestAttempt(trx: Trx, stepId: string): Promise<CallSessionRow | undefined> {
  return trx
    .selectFrom('call_sessions')
    .selectAll()
    .where('step_id', '=', stepId)
    .orderBy('attempt', 'desc')
    .executeTakeFirst();
}

export async function lockCall(trx: Trx, id: string): Promise<CallSessionRow | undefined> {
  return trx
    .selectFrom('call_sessions')
    .selectAll()
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst();
}

export interface NewAttempt {
  taskId: string;
  stepId: string;
  attempt: number;
  input: ApprovedCall;
  callerId: string;
  maxDurationSeconds: number;
  costEstimateMicro: number | null;
  approvalId: string | null;
  actionHash: string;
}

/**
 * Inserts attempt n (status queued) and its watchdog job, in the caller's transaction, before
 * anything is sent to the provider. Returns the row and the call's URL token (only its hash is
 * stored); a unique violation propagates (the attempt exists).
 */
export async function insertAttempt(
  trx: Trx,
  ctx: DbContext,
  config: Pick<Config, 'SECRET_ENCRYPTION_KEY'>,
  a: NewAttempt,
): Promise<{ row: CallSessionRow; token: string }> {
  const token = generateToken();
  const parsed = parsePhoneNumber(a.input.to);
  const at = new Date().toISOString();
  const row = await trx
    .insertInto('call_sessions')
    .values({
      tenant_id: ctx.tenantId,
      user_id: ctx.userId,
      task_id: a.taskId,
      step_id: a.stepId,
      attempt: a.attempt,
      idempotency_key: callIdempotencyKey(a.stepId, a.attempt),
      webhook_token_hash: sha256(token),
      callee_number: a.input.to,
      callee_number_hash: numberHash(config, a.input.to),
      callee_country: parsed?.country ?? null,
      callee_name: a.input.calleeName,
      callee_time_zone: a.input.calleeTimeZone ?? 'UTC',
      caller_id: a.callerId,
      language: a.input.language,
      purpose: a.input.purpose,
      dialog_mode: a.input.dialog,
      request: JSON.stringify(a.input),
      recording_mode: a.input.recording,
      status_timeline: JSON.stringify([
        { status: 'queued', providerStatus: null, sequence: null, at } satisfies CallStatusEvent,
      ]),
      max_duration_seconds: a.maxDurationSeconds,
      cost_estimate_micro: a.costEstimateMicro,
      approval_id: a.approvalId,
      action_hash: a.actionHash,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await enqueue(trx, {
    kind: 'call.timeout',
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    taskId: a.taskId,
    payload: { callId: row.id },
    dedupeKey: `call-timeout:${row.id}`,
    runAt: new Date(Date.now() + watchdogDelaySeconds(a.maxDurationSeconds) * 1000),
    maxAttempts: 5,
  });
  await callChanged(trx, ctx, row);
  return { row, token };
}

function withEvent(
  row: CallSessionRow,
  e: Omit<CallStatusEvent, 'at'> & { at?: string },
): CallStatusEvent[] {
  const timeline = [...((row.status_timeline ?? []) as CallStatusEvent[])];
  const entry: CallStatusEvent = { ...e, at: e.at ?? new Date().toISOString() };
  if (timeline.length >= 64) timeline[timeline.length - 1] = entry;
  else timeline.push(entry);
  return timeline;
}

async function update(
  trx: Trx,
  id: string,
  set: Updateable<CallSessionsTable>,
): Promise<CallSessionRow> {
  return trx
    .updateTable('call_sessions')
    .set(set)
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** The provider accepted the create-call request: its call id, status dialing. */
export async function markDialing(
  trx: Trx,
  ctx: DbContext,
  row: CallSessionRow,
  sid: string,
): Promise<CallSessionRow> {
  const updated = await update(trx, row.id, {
    provider_call_sid: sid,
    status: RANK[row.status] < RANK.dialing ? 'dialing' : row.status,
    failure_reason: null,
    dialed_at: row.dialed_at ?? new Date(),
    status_timeline: JSON.stringify(
      withEvent(row, { status: 'dialing', providerStatus: 'queued', sequence: null }),
    ),
  });
  await callChanged(trx, ctx, updated);
  return updated;
}

/** The create-call request's outcome is unknown (timeout after sending, a 5xx). */
export async function markUnknown(
  trx: Trx,
  ctx: DbContext,
  row: CallSessionRow,
): Promise<CallSessionRow> {
  if (row.status !== 'queued') return row;
  const updated = await update(trx, row.id, {
    status: 'unknown',
    failure_reason: 'CALL_STATE_UNKNOWN',
    status_timeline: JSON.stringify(
      withEvent(row, { status: 'unknown', providerStatus: null, sequence: null }),
    ),
  });
  await callChanged(trx, ctx, updated);
  return updated;
}

const emptyOutcome = (result: CallOutcome['result']): CallOutcome => ({
  result,
  goalReached: false,
  details: { date: null, times: [], appointment: null, reply: null, answers: [] },
  notes: [],
  summaryMessage: null,
});

/** Nothing was placed (the provider refused, or reconciliation found no call): ended, failed. */
export async function markNotPlaced(
  trx: Trx,
  ctx: DbContext,
  row: CallSessionRow,
  reason: string,
): Promise<CallSessionRow> {
  if (row.status === 'ended') return row;
  const updated = await update(trx, row.id, {
    status: 'ended',
    result: 'failed',
    failure_reason: reason,
    outcome: JSON.stringify(emptyOutcome('failed')),
    ended_at: new Date(),
    status_timeline: JSON.stringify(
      withEvent(row, { status: 'ended', providerStatus: null, sequence: null }),
    ),
  });
  await callChanged(trx, ctx, updated);
  return updated;
}

/**
 * A webhook (or the provider's call list) names this attempt's call: adopt its id once. An
 * unknown attempt becomes known (dialing) — the call exists, so it is never dialled again.
 */
export async function adoptSid(
  trx: Trx,
  ctx: DbContext,
  row: CallSessionRow,
  sid: string,
): Promise<CallSessionRow> {
  if (row.provider_call_sid) return row;
  if (row.status === 'ended') return row;
  return markDialing(trx, ctx, row, sid);
}

/** Moves the status forward (never back); records the provider's word and sequence. */
export async function advance(
  trx: Trx,
  ctx: DbContext,
  row: CallSessionRow,
  to: Exclude<CallStatusValue, 'ended' | 'unknown' | 'queued'>,
  e: { providerStatus: string | null; sequence: number | null; answered?: boolean },
): Promise<CallSessionRow> {
  if (row.status === 'ended') return row;
  const forward = RANK[to] > RANK[row.status];
  const answeredAt = e.answered && !row.answered_at ? new Date() : row.answered_at;
  if (!forward && answeredAt === row.answered_at && e.sequence === null) return row;
  const updated = await update(trx, row.id, {
    status: forward ? to : row.status,
    failure_reason: forward && row.status === 'unknown' ? null : row.failure_reason,
    answered_at: answeredAt,
    last_status_sequence:
      e.sequence === null
        ? row.last_status_sequence
        : Math.max(row.last_status_sequence ?? -1, e.sequence),
    status_timeline: forward
      ? JSON.stringify(
          withEvent(row, { status: to, providerStatus: e.providerStatus, sequence: e.sequence }),
        )
      : JSON.stringify(row.status_timeline ?? []),
  });
  if (forward) await callChanged(trx, ctx, updated);
  return updated;
}

/* ------------------------------------------------------------------ */
/* Turns                                                               */
/* ------------------------------------------------------------------ */

export async function loadTurns(trx: Trx, callId: string): Promise<TurnView[]> {
  const rows = await trx
    .selectFrom('call_turns')
    .select(['sequence', 'speaker', 'kind', 'text', 'confidence', 'flagged'])
    .where('call_session_id', '=', callId)
    .orderBy('sequence')
    .execute();
  return rows.map((r) => ({
    ...r,
    confidence: r.confidence === null ? null : Number(r.confidence),
  }));
}

export interface NewTurn {
  speaker: 'agent' | 'callee' | 'system';
  kind: TurnView['kind'];
  text: string;
  confidence?: number | null;
  flagged?: boolean;
  injectionSignals?: string[];
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/**
 * Stores turns from `sequence` on (a repeated webhook cannot add a turn twice: UNIQUE
 * (call, sequence), ON CONFLICT DO NOTHING) and moves turn_count past them.
 */
export async function appendTurns(
  trx: Trx,
  ctx: DbContext,
  row: CallSessionRow,
  sequence: number,
  turns: readonly NewTurn[],
): Promise<CallSessionRow> {
  let seq = sequence;
  for (const t of turns) {
    if (seq >= 200) break;
    const inserted = await trx
      .insertInto('call_turns')
      .values({
        tenant_id: ctx.tenantId,
        user_id: ctx.userId,
        call_session_id: row.id,
        sequence: seq,
        speaker: t.speaker,
        kind: t.kind,
        text: clip(
          t.text.trim() || '…',
          t.speaker === 'callee' ? CALL_LIMITS.maxCalleeUtteranceChars : 1000,
        ),
        language: row.language,
        confidence: t.speaker === 'callee' ? (t.confidence ?? null) : null,
        flagged: t.speaker === 'callee' ? (t.flagged ?? false) : false,
        injection_signals: t.speaker === 'callee' ? (t.injectionSignals ?? []).slice(0, 16) : [],
      })
      .onConflict((oc) => oc.columns(['call_session_id', 'sequence']).doNothing())
      .returning('sequence')
      .executeTakeFirst();
    if (inserted)
      await appendEvent(trx, ctx, {
        taskId: row.task_id,
        type: 'call.turn',
        data: { callId: row.id, taskId: row.task_id, sequence: seq, speaker: t.speaker },
      });
    seq++;
  }
  if (seq <= row.turn_count) return row;
  return update(trx, row.id, { turn_count: seq });
}

/* ------------------------------------------------------------------ */
/* Ending                                                              */
/* ------------------------------------------------------------------ */

/** The result line of an ended call (server sentence; clients render it in their locale). */
export function resultLine(
  input: { calleeName: string | null; to: string },
  outcome: Pick<CallOutcome, 'result' | 'notes'>,
): ServerMessage | null {
  const who = calleeLabel(input);
  if (outcome.notes.includes('TRANSFER_CONNECTED')) return msg('result.callTransferred', { who });
  if (outcome.result === 'completed') return msg('result.callCompleted', { who });
  if (outcome.result === 'answered') return msg('result.callAnswered', { who });
  return null;
}

export interface EndFacts {
  providerStatus: OutcomeFacts['providerStatus'];
  durationSeconds: number | null;
  failureDetail?: string | null;
  sequence?: number | null;
  cancelledByJarvis?: boolean;
}

/**
 * Ends the attempt (once): result, failure reason and outcome from the turns, end time,
 * duration. Later calls are no-ops.
 */
export async function finalizeCall(
  trx: Trx,
  ctx: DbContext,
  row: CallSessionRow,
  ownName: string,
  e: EndFacts,
): Promise<CallSessionRow> {
  if (row.status === 'ended') return row;
  const turns = await loadTurns(trx, row.id);
  const input = row.request as unknown as ApprovedCall;
  const computed = computeOutcome({
    input,
    ownName,
    turns,
    recordingConsent: row.recording_consent,
    providerStatus: e.providerStatus,
    failureDetail: e.failureDetail ?? null,
    answeredBy: row.answered_by,
    answered: row.ai_disclosed_at !== null,
    transferStatus: row.transfer_status,
    cancelledByJarvis: e.cancelledByJarvis ?? false,
  });
  const outcome: CallOutcome = {
    result: computed.result,
    goalReached: computed.goalReached,
    details: computed.details,
    notes: computed.notes,
    summaryMessage: resultLine(input, computed),
  };
  const updated = await update(trx, row.id, {
    status: 'ended',
    result: computed.result,
    failure_reason: computed.failureReason,
    outcome: JSON.stringify(outcome),
    ended_at: new Date(),
    duration_seconds: e.durationSeconds ?? row.duration_seconds,
    status_timeline: JSON.stringify(
      withEvent(row, {
        status: 'ended',
        providerStatus: e.providerStatus,
        sequence: e.sequence ?? null,
      }),
    ),
    last_status_sequence:
      e.sequence === null || e.sequence === undefined
        ? row.last_status_sequence
        : Math.max(row.last_status_sequence ?? -1, e.sequence),
  });
  await callChanged(trx, ctx, updated);
  return updated;
}

/** An ended call accepts nothing after this grace period (late webhooks are ignored). */
export function pastGrace(row: CallSessionRow, now = new Date()): boolean {
  return (
    row.status === 'ended' &&
    row.ended_at !== null &&
    now.getTime() - new Date(row.ended_at).getTime() >
      TELEPHONY_WEBHOOK_LIMITS.lateEventGraceSeconds * 1000
  );
}

/**
 * The provider's price of an ended call, recorded once: call_sessions.price_* and a cost record
 * (category telephony) — added to the task's actual cost when it is in USD.
 */
export async function recordPrice(
  trx: Trx,
  ctx: DbContext,
  row: CallSessionRow,
  price: { micro: number; currency: string } | null,
): Promise<CallSessionRow> {
  if (!price || row.price_micro !== null) return row;
  const updated = await trx
    .updateTable('call_sessions')
    .set({ price_micro: price.micro, price_currency: price.currency })
    .where('id', '=', row.id)
    .where('price_micro', 'is', null)
    .returningAll()
    .executeTakeFirst();
  if (!updated) return row;
  if (price.micro > 0) {
    await trx
      .insertInto('cost_records')
      .values({
        tenant_id: ctx.tenantId,
        user_id: ctx.userId,
        task_id: row.task_id,
        category: 'telephony',
        amount_micro: price.micro,
        currency: price.currency,
      })
      .execute();
    if (price.currency === 'USD')
      await trx
        .updateTable('tasks')
        .set({ actual_cost_micro: sql`actual_cost_micro + ${price.micro}` as unknown as number })
        .where('id', '=', row.task_id)
        .execute();
  }
  return updated;
}

/** The name JARVIS speaks for: the one the user approved (approval details), else the account's. */
export async function onBehalfOf(
  trx: Trx,
  row: Pick<CallSessionRow, 'approval_id' | 'user_id'>,
): Promise<string> {
  if (row.approval_id) {
    const a = await trx
      .selectFrom('approvals')
      .select('details')
      .where('id', '=', row.approval_id)
      .executeTakeFirst();
    const name = (a?.details as { onBehalfOf?: unknown } | undefined)?.onBehalfOf;
    if (typeof name === 'string' && name) return name;
  }
  const u = await trx
    .selectFrom('users')
    .select('display_name')
    .where('id', '=', row.user_id)
    .executeTakeFirst();
  return u?.display_name ?? 'JARVIS';
}

export type { Locale };
