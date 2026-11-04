/**
 * phone.call — an outbound call that says first that it is JARVIS, an AI assistant calling on
 * behalf of the user, pursues exactly one approved goal in German, Arabic or English, and
 * reports a structured outcome with evidence (docs/architecture/phase-d.md §3.2, ADR-0020,
 * docs/security/telephony.md).
 *
 *   Risk MEDIUM; HIGH for purpose 'appointment' (binding: BINDING_COMMITMENT). Always approved
 *   first (policy-telephony.ts: PHONE_CALL, + CALL_RECORDING / CALL_PERSONAL_INFO; denied for
 *   blocked destinations, do-not-call numbers, outside the callee's calling hours, over the
 *   daily limit, or without a telephony provider).
 *   The number must be written in the user's request (phoneNumbers → NUMBER_NOT_LITERAL); bind
 *   fixes the callee's zone, the dialog mode and the exact script (the approval's action hash
 *   covers the words).
 *   Exactly once per attempt (modules/telephony/attempts.ts); an unknown provider state is
 *   OUTCOME_UNKNOWN (CALL_STATE_UNKNOWN) and an acknowledged retry reconciles before dialling.
 *   Unsuccessful calls fail the step with their precise reason (CALL_BUSY, CALL_NO_ANSWER,
 *   CALL_FAILED, CALL_VOICEMAIL, CALL_HUNG_UP — retryable: a retry is a new attempt, checked by
 *   the policy again; CALL_DECLINED / RECORDING_CONSENT_DECLINED — not retried).
 *   A task cancelled during the call: JARVIS says a closing line and hangs up; the step and the
 *   task end CANCELLED.
 */
import {
  CALL_LIMITS,
  PhoneCallInput,
  type CallOutcome,
  type Locale,
  type ServerMessage,
} from '@jarvis/contracts';
import { withContext } from '../../../../db/pool';
import type { CallSessionRow } from '../../../../db/types';
import { hashObject } from '../../../../lib/crypto';
import { maskPhoneNumber, parsePhoneNumber, regionOfNumber } from '../../../../lib/phone';
import {
  attemptDeadline,
  dial,
  planAttempt,
  readAttempt,
  reconcile,
  settlePrice,
  unknownOutcome,
  type AttemptPlan,
} from '../../../telephony/attempts';
import {
  appendTurns,
  calleeLabel,
  finalizeCall,
  loadTurns,
  lockCall,
  onBehalfOf,
  resultLine,
} from '../../../telephony/calls';
import {
  buildScript,
  LINES,
  spokenDate,
  spokenList,
  spokenTime,
} from '../../../telephony/dialog/script';
import { createTelephonyGateway, type TelephonyGateway } from '../../../telephony/gateway';
import * as twiml from '../../../telephony/twilio/twiml';
import { TelephonyError } from '../../../telephony/twilio/errors';
import { AgentError, ToolCancelledError } from '../../errors';
import { msg, render } from '../../i18n';
import { hasTemplate } from '../../templates';
import { check, evidence, type ToolDefinition, type ToolRuntime } from '../types';

type Input = PhoneCallInput;

/** How often the step looks at its call while it runs. */
export const CALL_POLL_MS = 200;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });

const SUCCESS = new Set(['completed', 'answered']);

/* ------------------------------------------------------------------ */
/* What the user reads (request language)                              */
/* ------------------------------------------------------------------ */

const TEXT = {
  en: {
    free: (d: string, t: string) => `Free on ${d}: ${t}.`,
    none: (d: string) => `Nothing is free on ${d}.`,
    booked: (d: string, t: string, ref: string | null) =>
      `Appointment on ${d} at ${t}${ref ? ` (reference ${ref})` : ''}.`,
    delivered: (reply: string | null) =>
      reply ? `Message delivered. Their reply: “${reply}”` : 'Message delivered.',
    answer: (q: string, a: string | null) => `${q} — ${a ?? 'no answer'}`,
    transferred: () => 'They were put through to you.',
    noGoal: () => 'The call ended without the goal being reached.',
  },
  de: {
    free: (d: string, t: string) => `Frei am ${d}: ${t}.`,
    none: (d: string) => `Am ${d} ist nichts frei.`,
    booked: (d: string, t: string, ref: string | null) =>
      `Termin am ${d} um ${t}${ref ? ` (Referenz ${ref})` : ''}.`,
    delivered: (reply: string | null) =>
      reply ? `Nachricht ausgerichtet. Antwort: „${reply}“` : 'Nachricht ausgerichtet.',
    answer: (q: string, a: string | null) => `${q} – ${a ?? 'keine Antwort'}`,
    transferred: () => 'Der Anruf wurde zu dir durchgestellt.',
    noGoal: () => 'Der Anruf endete, ohne dass das Ziel erreicht wurde.',
  },
  ar: {
    free: (d: string, t: string) => `متاح يوم ${d}: ${t}.`,
    none: (d: string) => `لا يوجد موعد متاح يوم ${d}.`,
    booked: (d: string, t: string, ref: string | null) =>
      `موعد يوم ${d} الساعة ${t}${ref ? ` (المرجع ${ref})` : ''}.`,
    delivered: (reply: string | null) =>
      reply ? `تم إبلاغ الرسالة. الرد: «${reply}»` : 'تم إبلاغ الرسالة.',
    answer: (q: string, a: string | null) => `${q} — ${a ?? 'لا توجد إجابة'}`,
    transferred: () => 'تم تحويل المكالمة إليك.',
    noGoal: () => 'انتهت المكالمة دون تحقيق الهدف.',
  },
} as const;

/** One or two sentences of what the call brought, in the request's language (content, not a server sentence). */
export function outcomeText(lang: Locale, input: Input, outcome: CallOutcome): string {
  const T = TEXT[lang];
  const d = outcome.details;
  const parts: string[] = [];
  if (outcome.notes.includes('TRANSFER_CONNECTED')) parts.push(T.transferred());
  if (d.appointment)
    parts.push(
      T.booked(
        spokenDate(lang, d.appointment.date),
        spokenTime(lang, d.appointment.time),
        d.appointment.reference,
      ),
    );
  else if (input.purpose === 'availability' || input.purpose === 'appointment') {
    if (d.date && d.times.length)
      parts.push(
        T.free(
          spokenDate(lang, d.date),
          spokenList(
            lang,
            d.times.map((t) => spokenTime(lang, t)),
          ),
        ),
      );
    else if (d.date && outcome.goalReached) parts.push(T.none(spokenDate(lang, d.date)));
  } else if (input.purpose === 'message' && outcome.goalReached) parts.push(T.delivered(d.reply));
  else if (input.purpose === 'questions')
    parts.push(
      ...d.answers.filter((a) => a.answer !== null).map((a) => T.answer(a.question, a.answer)),
    );
  if (parts.length === 0) parts.push(T.noGoal());
  return parts.join(' ');
}

/* ------------------------------------------------------------------ */
/* Step outcome                                                        */
/* ------------------------------------------------------------------ */

function lastProviderStatus(row: CallSessionRow): string {
  const timeline = (row.status_timeline ?? []) as { providerStatus: string | null }[];
  return [...timeline].reverse().find((e) => e.providerStatus)?.providerStatus ?? 'failed';
}

/** The step error of an ended, unsuccessful attempt (null for a successful one). */
export function callError(row: CallSessionRow): AgentError | null {
  const outcome = row.outcome as CallOutcome | null;
  const fail = (
    reason: NonNullable<AgentError['reason']>,
    message: string,
    retryable = true,
    params?: Record<string, string | number>,
  ) => new AgentError('TOOL_FAILED', message, { retryable, reason, ...(params ? { params } : {}) });
  switch (row.result) {
    case 'completed':
    case 'answered':
      if (outcome?.notes.includes('DURATION_LIMIT') && !outcome.goalReached)
        return fail(
          'CALL_DURATION_LIMIT',
          'The call reached its maximum duration before its goal.',
          true,
          {
            seconds: row.max_duration_seconds,
          },
        );
      return null;
    case 'busy':
      return fail('CALL_BUSY', 'The line was busy. Nothing was said or agreed.');
    case 'no_answer':
      return fail('CALL_NO_ANSWER', 'Nobody answered the call.');
    case 'voicemail':
      return fail('CALL_VOICEMAIL', 'An answering machine took the call.');
    case 'hung_up':
      return fail('CALL_HUNG_UP', 'The callee hung up before the goal was reached.');
    case 'declined':
      return row.failure_reason === 'RECORDING_CONSENT_DECLINED'
        ? fail(
            'RECORDING_CONSENT_DECLINED',
            'The callee did not agree to the recording, so the call was ended politely.',
            false,
          )
        : fail(
            'CALL_DECLINED',
            'The callee asked not to be called again (or not to talk to an AI assistant).',
            false,
          );
    case 'failed':
      if (row.failure_reason === 'PROVIDER_REJECTED')
        return fail(
          'PROVIDER_REJECTED',
          'The telephony provider refused to place the call.',
          true,
          {
            provider: 'twilio',
            status: 400,
          },
        );
      return fail('CALL_FAILED', 'The call could not be connected.', true, {
        status: lastProviderStatus(row),
      });
    case 'canceled':
      return fail('CALL_FAILED', 'The call was cancelled before it connected.', true, {
        status: 'canceled',
      });
    default:
      return unknownOutcome();
  }
}

async function approvedAction(rt: ToolRuntime, input: Input) {
  const actionHash = hashObject({ toolId: 'phone.call', resolvedInput: input });
  const row = await withContext(rt.db, rt.ctx, (trx) =>
    trx
      .selectFrom('approvals')
      .select('id')
      .where('step_id', '=', rt.stepId)
      .where('status', '=', 'APPROVED')
      .where('action_hash', '=', actionHash)
      .orderBy('decided_at', 'desc')
      .executeTakeFirst(),
  );
  return { approvalId: row?.id ?? null, actionHash };
}

const cancelRequested = (rt: ToolRuntime) =>
  withContext(rt.db, rt.ctx, (trx) =>
    trx
      .selectFrom('tasks')
      .select('cancel_requested_at')
      .where('id', '=', rt.taskId)
      .executeTakeFirst(),
  ).then((t) => !!t?.cancel_requested_at);

/** The task was cancelled while the call ran: a closing line, then hang up (once). */
async function endForCancel(
  rt: ToolRuntime,
  gw: TelephonyGateway,
  row: CallSessionRow,
): Promise<void> {
  if (!row.provider_call_sid) return;
  if (!row.ai_disclosed_at) {
    try {
      await gw.updateCall(row.provider_call_sid, { status: 'canceled' });
      return;
    } catch {
      // Answered meanwhile: say the closing line instead.
    }
  }
  const line = LINES[row.language].cancelled();
  await withContext(rt.db, rt.ctx, async (trx) => {
    const r = (await lockCall(trx, row.id))!;
    if (r.status !== 'ended')
      await appendTurns(trx, rt.ctx, r, r.turn_count, [
        { speaker: 'agent', kind: 'goodbye', text: line },
      ]);
  });
  try {
    await gw.updateCall(row.provider_call_sid, {
      twiml: twiml.response(twiml.say(line, row.language), twiml.hangup()),
    });
  } catch {
    await gw.updateCall(row.provider_call_sid, { status: 'completed' }).catch(() => undefined);
  }
}

/** Ends the attempt from the provider's record (or as JARVIS ended it) when no callback arrives. */
async function hangUpAndSettle(
  rt: ToolRuntime,
  gw: TelephonyGateway,
  row: CallSessionRow,
  cancelled: boolean,
) {
  if (row.provider_call_sid) {
    await gw.updateCall(row.provider_call_sid, { status: 'completed' }).catch(() => undefined);
    try {
      const r = await reconcile(rt.db, rt.ctx, gw, row);
      if (r.status === 'ended') return r;
    } catch {
      // Below: JARVIS's own end.
    }
  }
  return withContext(rt.db, rt.ctx, async (trx) => {
    const r = (await lockCall(trx, row.id))!;
    return finalizeCall(trx, rt.ctx, r, await onBehalfOf(trx, r), {
      providerStatus: r.ai_disclosed_at ? 'completed' : 'canceled',
      durationSeconds: null,
      cancelledByJarvis: cancelled,
    });
  });
}

/** Waits until the attempt ended (webhooks drive it), handling cancellation and the deadline. */
async function waitForEnd(
  rt: ToolRuntime,
  gw: TelephonyGateway,
  start: CallSessionRow,
  signal: AbortSignal,
): Promise<{ row: CallSessionRow; cancelled: boolean }> {
  const deadline = attemptDeadline(start);
  let cancelled = false;
  let cancelDeadline = 0;
  let row = start;
  for (;;) {
    row = await readAttempt(rt.db, rt.ctx, row.id);
    if (row.status === 'ended') return { row, cancelled };
    if (!cancelled && (await cancelRequested(rt))) {
      cancelled = true;
      cancelDeadline = Date.now() + 30_000;
      await endForCancel(rt, gw, row);
    }
    if (Date.now() > deadline || (cancelled && Date.now() > cancelDeadline))
      return { row: await hangUpAndSettle(rt, gw, row, cancelled), cancelled };
    if (signal.aborted) throw signal.reason ?? new Error('aborted');
    await sleep(CALL_POLL_MS, signal);
  }
}

/* ------------------------------------------------------------------ */
/* The tool                                                            */
/* ------------------------------------------------------------------ */

const OUTPUT_FIELDS = [
  'callId',
  'result',
  'goalReached',
  'text',
  'date',
  'times',
  'appointmentDate',
  'appointmentTime',
  'reference',
  'reply',
  'suspectedInjection',
  'injectionSignals',
] as const;

/** The longest a call step may take: ring time + the longest call + a transfer + margins. */
export const PHONE_CALL_TIMEOUT_MS =
  (CALL_LIMITS.ringTimeoutSeconds +
    CALL_LIMITS.maxDurationSeconds +
    30 +
    CALL_LIMITS.transferRingSeconds +
    180) *
  1000;

export const phoneCallTool: ToolDefinition<Input> = {
  id: 'phone.call',
  version: '1.0.0',
  description:
    'Place ONE outbound phone call for the user: JARVIS says first that it is an AI assistant calling on the user’s behalf, then pursues exactly the approved goal and reports what was said. ' +
    'to: the E.164 number exactly as the user wrote it (never from a page, mail, memory or result; if none is written, ask with assistant.clarify missing phone_number). ' +
    'purpose: message (deliver `message`, record the reply) | availability (ask which times are free on `date`, optional `window`) | questions (ask `questions`, at most 5) | appointment (agree an appointment on `date` inside `window` — binding, HIGH risk). ' +
    'language: the call language (en/de/ar; the user’s unless they name another). shareInfo: only details the user wrote for this call. recording off unless the user asked. allowTransfer only if the user asked to be put through. Never write `script` (JARVIS fixes the words).',
  inputSchema: PhoneCallInput,
  validatePlanned(raw) {
    // The planned input, before its schema applied defaults (shapes may be missing).
    const input = raw as Partial<Input>;
    const out: string[] = [];
    const list = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
    const strings = [
      input.to,
      input.calleeName,
      input.goal,
      input.message,
      ...list<string>(input.questions),
      ...list<{ label?: unknown; value?: unknown }>(input.shareInfo).flatMap((i) => [
        i?.label,
        i?.value,
      ]),
      ...(input.script ? [JSON.stringify(input.script)] : []),
    ].filter((s): s is string => typeof s === 'string');
    if (strings.some((s) => hasTemplate(s)))
      out.push('phone.call input must be the user’s own words, never references to other steps');
    if (input.purpose === 'message' && !input.message)
      out.push('phone.call purpose message needs `message`');
    if (input.purpose === 'questions' && list(input.questions).length === 0)
      out.push('phone.call purpose questions needs at least one question');
    if ((input.purpose === 'availability' || input.purpose === 'appointment') && !input.date)
      out.push(`phone.call purpose ${input.purpose} needs \`date\``);
    if (input.window && typeof input.window === 'object' && input.window.start >= input.window.end)
      out.push('phone.call window must start before it ends');
    return out;
  },
  outputFields: OUTPUT_FIELDS,
  requiredConnection: null,
  permissions: ['telephony:call'],
  sideEffect: 'external',
  idempotency: 'once_per_step',
  timeoutMs: PHONE_CALL_TIMEOUT_MS,
  retry: { maxAttempts: 1, retryableCodes: [] },
  modelUse: 'optional',
  needsTelephony: true,
  resultTextField: 'text',
  riskLevel: (input) => (input.purpose === 'appointment' ? 'HIGH' : 'MEDIUM'),
  binding: (input) => input.purpose === 'appointment',
  phoneNumbers: (input) => [input.to],
  call: (input) => ({
    to: input.to,
    calleeTimeZone: input.calleeTimeZone,
    purpose: input.purpose,
    recording: input.recording,
    sharedDetails: input.shareInfo.length,
    allowTransfer: input.allowTransfer,
  }),
  bind(input, ctx) {
    const ownName = ctx.ownName?.trim() || ctx.accountEmail;
    const dialog = ctx.modelAvailable ? 'model' : 'scripted';
    return {
      ...input,
      calleeTimeZone: input.calleeTimeZone ?? ctx.timeZone,
      dialog,
      script: buildScript({
        language: input.language,
        ownName,
        purpose: input.purpose,
        date: input.date,
        window: input.window,
        message: input.message,
        questions: input.questions,
        recording: input.recording,
        voicemail: input.voicemail,
      }),
    };
  },
  estimateCostMicro: (input, ctx) =>
    // The model dialog: a few short structured decisions on the balanced tier.
    input.dialog === 'model' && ctx.modelAvailable ? 20_000 : 0,
  preview: (input) => ({
    to: parsePhoneNumber(input.to)?.international ?? input.to,
    calleeName: input.calleeName,
    language: input.language,
    purpose: input.purpose,
    goal: input.goal,
    date: input.date,
    window: input.window,
    questions: input.questions.length,
    shareInfo: input.shareInfo.map((i) => i.label),
    maxDurationSeconds: input.maxDurationSeconds,
    recording: input.recording,
    voicemail: input.voicemail,
    allowTransfer: input.allowTransfer,
    dialog: input.dialog,
  }),
  approvalDetails(input, ctx) {
    const t = ctx.telephony;
    const parsed = parsePhoneNumber(input.to);
    const who = calleeLabel(input);
    const maxSeconds = Math.min(
      input.maxDurationSeconds,
      t?.maxCallSeconds || input.maxDurationSeconds,
    );
    const summaryMessage: ServerMessage = msg('approval.call', { who, number: input.to });
    const script =
      input.script ??
      buildScript({
        language: input.language,
        ownName: t?.onBehalfOf ?? ctx.account?.email ?? '',
        purpose: input.purpose,
        date: input.date,
        window: input.window,
        message: input.message,
        questions: input.questions,
        recording: input.recording,
        voicemail: input.voicemail,
      });
    return {
      details: {
        kind: 'phone_call',
        to: input.to,
        toDisplay: parsed?.international ?? input.to,
        country: parsed?.country ?? regionOfNumber(input.to),
        calleeName: input.calleeName,
        onBehalfOf: t?.onBehalfOf ?? '',
        callerId: t?.callerId ?? null,
        callerIdDisplay: t?.callerId
          ? (parsePhoneNumber(t.callerId)?.international ?? t.callerId)
          : null,
        language: input.language,
        purpose: input.purpose,
        goal: input.goal,
        script,
        dialog: input.dialog,
        date: input.date,
        window: input.window,
        shareInfo: input.shareInfo,
        maxDurationSeconds: maxSeconds,
        allowedHours: {
          start: t?.allowedHours.start ?? CALL_LIMITS.defaultAllowedHours.start,
          end: t?.allowedHours.end ?? CALL_LIMITS.defaultAllowedHours.end,
          timeZone: input.calleeTimeZone ?? ctx.account?.timeZone ?? 'UTC',
        },
        recording: input.recording,
        voicemail: input.voicemail,
        transfer: {
          allowed: input.allowTransfer,
          to: input.allowTransfer ? (t?.transferTo ?? null) : null,
        },
        binding: input.purpose === 'appointment',
        costEstimate:
          t?.pricePerMinuteMicroUsd === null || t?.pricePerMinuteMicroUsd === undefined
            ? null
            : {
                amountMicro: t.pricePerMinuteMicroUsd * Math.ceil(maxSeconds / 60),
                currency: 'USD',
              },
      },
      summary: render(ctx.language, summaryMessage),
      summaryMessage,
    };
  },
  resultLine: (input, output) =>
    resultLine(input, {
      result: output.result as CallOutcome['result'],
      notes: (output.notes as CallOutcome['notes'] | undefined) ?? [],
    }),
  resultFact: (input, output) =>
    `Phone call to ${calleeLabel(input)}: ${String(output.result ?? '')}. ${String(output.text ?? '')}`.slice(
      0,
      500,
    ),
  async execute(input, rt, signal) {
    const gw = createTelephonyGateway(rt.config);
    const t = rt.config.telephony;
    if (!gw || !t)
      throw new AgentError(
        'SERVICE_UNAVAILABLE',
        'Phone calls are not configured on this server.',
        {
          retryable: true,
          reason: 'TELEPHONY_NOT_CONFIGURED',
        },
      );
    if (!input.script)
      throw new AgentError('TOOL_FAILED', 'The call has no approved script.', {
        reason: 'INVALID_STEP_INPUT',
        params: { step: 'phone.call' },
      });
    const approved = { ...input, script: input.script };
    const { approvalId, actionHash } = await approvedAction(rt, input);
    const maxDurationSeconds = Math.max(
      CALL_LIMITS.minDurationSeconds,
      Math.min(input.maxDurationSeconds, t.maxCallSeconds),
    );
    const attempt = {
      taskId: rt.taskId,
      stepId: rt.stepId,
      input: approved,
      callerId: t.fromNumber,
      maxDurationSeconds,
      costEstimateMicro:
        t.pricePerMinuteMicroUsd === null
          ? null
          : t.pricePerMinuteMicroUsd * Math.ceil(maxDurationSeconds / 60),
      approvalId,
      actionHash,
    };
    const run = async (plan: AttemptPlan): Promise<CallSessionRow> => {
      switch (plan.kind) {
        case 'dial':
          return dial(rt.db, rt.ctx, gw, plan, signal);
        case 'wait':
        case 'reuse':
          return plan.row;
        case 'reconcile': {
          let r: CallSessionRow;
          try {
            r = await reconcile(rt.db, rt.ctx, gw, plan.row);
          } catch (err) {
            if (err instanceof TelephonyError) throw unknownOutcome();
            throw err;
          }
          if (r.status === 'unknown' || r.status === 'queued') throw unknownOutcome();
          // The provider has no such call: nothing was placed, so the next attempt may dial.
          if (r.status === 'ended' && !r.provider_call_sid) {
            const again = await planAttempt(rt.db, rt.ctx, rt.config, attempt, rt.account.timeZone);
            if (again.kind !== 'dial') return again.row;
            return dial(rt.db, rt.ctx, gw, again, signal);
          }
          return r;
        }
      }
    };
    const placed = await run(
      await planAttempt(rt.db, rt.ctx, rt.config, attempt, rt.account.timeZone),
    );
    const { row: ended, cancelled } = await waitForEnd(rt, gw, placed, signal);
    const row = await settlePrice(rt.db, rt.ctx, gw, ended);
    // The step and the task end CANCELLED (executor.ts); the call is recorded as it really ended.
    if (cancelled) throw new ToolCancelledError('The task was cancelled during the call.');
    const failure = callError(row);
    if (failure) throw failure;

    const outcome = row.outcome as CallOutcome;
    const turns = await withContext(rt.db, rt.ctx, (trx) => loadTurns(trx, row.id));
    const flagged = turns.filter((x) => x.speaker === 'callee' && x.flagged);
    const signals = [
      ...new Set(
        (
          await withContext(rt.db, rt.ctx, (trx) =>
            trx
              .selectFrom('call_turns')
              .select('injection_signals')
              .where('call_session_id', '=', row.id)
              .where('flagged', '=', true)
              .execute(),
          )
        ).flatMap((r) => r.injection_signals),
      ),
    ].sort();
    const disclosure = turns.find((x) => x.sequence === 0 && x.kind === 'disclosure') ?? null;
    const consentTurn =
      turns.find((x) => x.speaker === 'callee' && x.kind === 'consent_reply') ?? null;
    const sid = row.provider_call_sid!;
    const text = outcomeText(rt.language, input, outcome);
    const d = outcome.details;
    const output = {
      callId: row.id,
      callSid: sid,
      attempt: row.attempt,
      result: row.result,
      goalReached: outcome.goalReached,
      text,
      date: d.date,
      times: d.times,
      appointmentDate: d.appointment?.date ?? null,
      appointmentTime: d.appointment?.time ?? null,
      reference: d.appointment?.reference ?? null,
      reply: d.reply,
      answers: d.answers,
      notes: outcome.notes,
      suspectedInjection: flagged.length > 0,
      injectionSignals: signals,
      durationSeconds: row.duration_seconds,
      disclosure: disclosure
        ? {
            sequence: disclosure.sequence,
            at: row.ai_disclosed_at ? new Date(row.ai_disclosed_at).toISOString() : null,
          }
        : null,
      consent: row.recording_consent,
      recorded: row.recording_sid !== null,
      turns: turns.length,
      transfer: row.transfer_status,
    };
    const ev = [
      evidence('provider_response', 'Call placed', sid, 'CALL_PLACED', {
        provider: 'twilio',
        callSid: sid,
      }),
      ...(disclosure
        ? [
            evidence('record', 'AI disclosed', `turn ${disclosure.sequence}`, 'AI_DISCLOSED', {
              callSid: sid,
              sequence: disclosure.sequence,
            }),
          ]
        : []),
      ...(row.recording_consent !== 'not_asked'
        ? [
            evidence('record', 'Recording consent', row.recording_consent, 'RECORDING_CONSENT', {
              callSid: sid,
              consent: row.recording_consent,
              sequence: consentTurn?.sequence ?? -1,
            }),
          ]
        : []),
      ...(row.transfer_status !== 'none'
        ? [
            evidence('provider_response', 'Transfer', row.transfer_status, 'CALL_TRANSFER', {
              callSid: sid,
              status: row.transfer_status,
            }),
          ]
        : []),
      evidence('record', 'Call transcript', `${turns.length} turns`, 'CALL_TRANSCRIPT', {
        callId: row.id,
        turns: turns.length,
      }),
      evidence('provider_response', 'Call ended', String(row.result), 'CALL_ENDED', {
        callSid: sid,
        result: String(row.result),
        seconds: row.duration_seconds ?? 0,
      }),
      ...(outcome.notes.includes('OPTED_OUT')
        ? [
            evidence(
              'record',
              'Do-not-call',
              maskPhoneNumber(row.callee_number),
              'DO_NOT_CALL_RECORDED',
              { number: maskPhoneNumber(row.callee_number) },
            ),
          ]
        : []),
    ];
    const preview = {
      callId: row.id,
      attempt: row.attempt,
      result: row.result,
      goalReached: outcome.goalReached,
      text,
      times: d.times,
      durationSeconds: row.duration_seconds,
      turns: turns.length,
    };
    return { output, outputPreview: preview, evidence: ev, costMicro: 0 };
  },
  verify(_input, output) {
    const sid = typeof output.callSid === 'string' ? output.callSid : '';
    const disclosure = output.disclosure as { sequence: number } | null | undefined;
    const result = String(output.result ?? '');
    const turns = typeof output.turns === 'number' ? output.turns : 0;
    const consent = String(output.consent ?? 'not_asked');
    const recorded = output.recorded === true;
    const details =
      (Array.isArray(output.times) ? output.times.length : 0) +
      (output.reply ? 1 : 0) +
      (output.appointmentTime ? 1 : 0) +
      (Array.isArray(output.answers)
        ? (output.answers as { answer: unknown }[]).filter((a) => a.answer !== null).length
        : 0);
    const checks = [
      check('callConnected', sid ? `Call ${sid} connected` : 'No call id', { callSid: sid }),
      check(
        'aiDisclosed',
        disclosure?.sequence === 0
          ? 'The opening said it is an AI assistant'
          : 'No AI disclosure turn',
      ),
      check('callEnded', `The call ended: ${result}`, { result }),
      output.goalReached === true
        ? check('goalReached', 'The goal of the call was reached')
        : check('detailsCollected', `${details} details collected`, { count: details }),
      check('consentRespected', recorded ? 'Recorded with the callee’s consent' : 'Not recorded', {
        consent,
      }),
      check('transcriptStored', `${turns} turns stored`, { turns }),
    ];
    const ok =
      !!sid &&
      disclosure?.sequence === 0 &&
      SUCCESS.has(result) &&
      (!recorded || consent === 'accepted') &&
      turns > 0;
    return { ok, checks };
  },
  audit: (_input, output) => ({
    action: 'telephony.call_ended',
    metadata: {
      callId: output.callId,
      result: output.result,
      attempt: output.attempt,
      durationSeconds: output.durationSeconds,
    },
  }),
};
