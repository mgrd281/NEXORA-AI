/**
 * Read models of the phone agent's records (docs/architecture/phase-d.md §3.7, §4.5): contract
 * CallSession / CallSummary / CallTurn / DoNotCallEntry / PhoneVerification. Shared by the
 * call routes, TaskDetail.calls and the account export, so a call looks the same everywhere.
 * Never exposed: the URL-token hash, the number hashes, the sealed numbers and codes, the
 * idempotency key, the action hash.
 */
import {
  CALL_LIMITS,
  type CallOutcome,
  type CallSession,
  type CallStatusEvent,
  type CallSummary,
  type CallTurn,
  type DoNotCallEntry,
  type PhoneVerification,
  type TaskErrorReason,
} from '@jarvis/contracts';
import type { Trx } from '../../db/pool';
import type {
  CallSessionRow,
  CallTurnRow,
  DoNotCallRow,
  PhoneVerificationRow,
} from '../../db/types';
import { parsePhoneNumber, maskPhoneNumber } from '../../lib/phone';
import { asMessage } from '../agent/i18n';

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

/** call_sessions columns the read model uses (no hashes, keys or tokens). */
export const CALL_COLUMNS = [
  'id',
  'task_id',
  'step_id',
  'attempt',
  'callee_number',
  'callee_name',
  'language',
  'purpose',
  'status',
  'result',
  'failure_reason',
  'outcome',
  'provider',
  'provider_call_sid',
  'answered_by',
  'ai_disclosed_at',
  'recording_mode',
  'recording_consent',
  'recording_consent_at',
  'transfer_status',
  'transfer_at',
  'status_timeline',
  'duration_seconds',
  'max_duration_seconds',
  'cost_estimate_micro',
  'price_micro',
  'price_currency',
  'dialed_at',
  'answered_at',
  'ended_at',
  'created_at',
  'updated_at',
] as const;

export type CallView = Pick<CallSessionRow, (typeof CALL_COLUMNS)[number]>;

export const TURN_COLUMNS = [
  'id',
  'call_session_id',
  'sequence',
  'speaker',
  'kind',
  'text',
  'language',
  'confidence',
  'flagged',
  'created_at',
] as const;
export type TurnRowView = Pick<CallTurnRow, (typeof TURN_COLUMNS)[number]>;

export function toCallTurn(t: TurnRowView): CallTurn {
  return {
    id: t.id,
    sequence: t.sequence,
    speaker: t.speaker,
    kind: t.kind,
    text: t.text,
    language: t.language,
    confidence: t.confidence === null ? null : Math.round(Number(t.confidence) * 1000) / 1000,
    flagged: t.flagged,
    at: new Date(t.created_at).toISOString(),
  };
}

const money = (micro: number | null, currency = 'USD') =>
  micro === null ? null : { amountMicro: Number(micro), currency };

export function toCallSummary(row: CallView, recordingArtifactId: string | null): CallSummary {
  return {
    id: row.id,
    taskId: row.task_id,
    stepId: row.step_id,
    attempt: row.attempt,
    to: row.callee_number,
    toDisplay: parsePhoneNumber(row.callee_number)?.international ?? row.callee_number,
    calleeName: row.callee_name,
    language: row.language,
    purpose: row.purpose,
    status: row.status,
    result: row.result,
    outcome: (row.outcome as CallOutcome | null) ?? null,
    provider: 'twilio',
    providerCallSid: row.provider_call_sid,
    answeredBy: row.answered_by,
    aiDisclosedAt: iso(row.ai_disclosed_at),
    recording: {
      mode: row.recording_mode,
      consent: row.recording_consent,
      consentAt: iso(row.recording_consent_at),
      artifactId: recordingArtifactId,
    },
    transfer: { status: row.transfer_status, at: iso(row.transfer_at) },
    durationSeconds: row.duration_seconds,
    maxDurationSeconds: row.max_duration_seconds,
    costEstimate: money(row.cost_estimate_micro),
    price: money(row.price_micro, row.price_currency ?? 'USD'),
    failureReason: (row.failure_reason as TaskErrorReason | null) ?? null,
    dialedAt: iso(row.dialed_at),
    answeredAt: iso(row.answered_at),
    endedAt: iso(row.ended_at),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

/** A call in GET /v1/calls: the summary plus its task's title (one query for the list). */
export function toCallListItem(
  row: CallView & { task_title: string; task_title_message: unknown },
  recordingArtifactId: string | null,
): CallSummary {
  return {
    ...toCallSummary(row, recordingArtifactId),
    taskTitle: row.task_title,
    taskTitleMessage: asMessage(row.task_title_message),
  };
}

export function toCallSession(
  row: CallView,
  turns: readonly TurnRowView[],
  recordingArtifactId: string | null,
): CallSession {
  return {
    ...toCallSummary(row, recordingArtifactId),
    timeline: ((row.status_timeline ?? []) as CallStatusEvent[]).map((e) => ({
      status: e.status,
      providerStatus: e.providerStatus,
      sequence: e.sequence,
      at: new Date(e.at).toISOString(),
    })),
    turns: turns.map(toCallTurn),
  };
}

/** Recording evidence files by call id (consented recordings only ever exist). */
export async function recordingsOf(
  trx: Trx,
  callIds: readonly string[],
): Promise<Map<string, string>> {
  if (callIds.length === 0) return new Map();
  const rows = await trx
    .selectFrom('evidence_artifacts')
    .select(['id', 'call_session_id'])
    .where('kind', '=', 'recording')
    .where('call_session_id', 'in', [...callIds])
    .execute();
  return new Map(rows.map((r) => [r.call_session_id!, r.id]));
}

export async function turnsOf(
  trx: Trx,
  callIds: readonly string[],
  perCall?: number,
): Promise<Map<string, TurnRowView[]>> {
  const out = new Map<string, TurnRowView[]>();
  if (callIds.length === 0) return out;
  const rows = await trx
    .selectFrom('call_turns')
    .select(TURN_COLUMNS)
    .where('call_session_id', 'in', [...callIds])
    .orderBy('call_session_id')
    .orderBy('sequence')
    .execute();
  for (const r of rows) {
    const list = out.get(r.call_session_id) ?? [];
    if (perCall === undefined || list.length < perCall) list.push(r);
    out.set(r.call_session_id, list);
  }
  return out;
}

/** The task's calls, oldest first, each with at most CALL_LIMITS.turnsInTaskDetail turns. */
export async function callsOfTask(trx: Trx, taskId: string): Promise<CallSession[]> {
  const rows = await trx
    .selectFrom('call_sessions')
    .select(CALL_COLUMNS)
    .where('task_id', '=', taskId)
    .orderBy('created_at')
    .orderBy('attempt')
    .execute();
  const ids = rows.map((r) => r.id);
  const [turns, recordings] = await Promise.all([
    turnsOf(trx, ids, CALL_LIMITS.turnsInTaskDetail),
    recordingsOf(trx, ids),
  ]);
  return rows.map((r) => toCallSession(r, turns.get(r.id) ?? [], recordings.get(r.id) ?? null));
}

export const DNC_COLUMNS = [
  'id',
  'number_masked',
  'country',
  'source',
  'call_session_id',
  'created_at',
] as const;
export type DncView = Pick<DoNotCallRow, (typeof DNC_COLUMNS)[number]> & {
  /** The task of the call during which the callee asked (null once that call is gone). */
  task_id: string | null;
};

/** do_not_call rows with the task of their call (RLS: the owner's own rows only). */
export function doNotCallQuery(trx: Trx) {
  return trx
    .selectFrom('do_not_call as d')
    .leftJoin('call_sessions as c', 'c.id', 'd.call_session_id')
    .select([...DNC_COLUMNS.map((col) => `d.${col}` as const), 'c.task_id']);
}

export function toDoNotCallEntry(r: DncView): DoNotCallEntry {
  return {
    id: r.id,
    number: r.number_masked,
    country: r.country,
    source: r.source,
    callId: r.call_session_id,
    taskId: r.task_id,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

export const VERIFICATION_COLUMNS = [
  'id',
  'phone_number',
  'status',
  'attempts',
  'expires_at',
  'created_at',
  'updated_at',
  'verified_at',
] as const;
export type VerificationView = Pick<PhoneVerificationRow, (typeof VERIFICATION_COLUMNS)[number]>;

/** A verification as the user sees it (the code never leaves the server except on the call). */
export function toPhoneVerification(r: VerificationView, now = new Date()): PhoneVerification {
  const expired =
    (r.status === 'calling' || r.status === 'pending') &&
    new Date(r.expires_at).getTime() <= now.getTime();
  return {
    id: r.id,
    status: expired ? 'expired' : r.status,
    number: maskPhoneNumber(r.phone_number),
    attemptsLeft: Math.max(0, CALL_LIMITS.verificationMaxAttempts - r.attempts),
    expiresAt: new Date(r.expires_at).toISOString(),
    createdAt: new Date(r.created_at).toISOString(),
  };
}
