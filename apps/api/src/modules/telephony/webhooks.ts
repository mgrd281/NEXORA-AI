/**
 * The call webhooks (docs/architecture/phase-d.md §3.3; contracts telephonyWebhookRoutes). The
 * route group (http/webhook-route.ts) has already checked the provider's signature over the
 * public URL and every parameter, the account, the request shapes, and found the owner by the
 * call id + the hash of its URL token — each handler runs in that owner's RLS context only.
 *
 * Replay, ordering and idempotency rules (on top of those checks):
 *   - the CallSid of every request must equal the attempt's once it is known (adopted once);
 *   - status: ignored when its Timestamp is older than maxEventAgeSeconds or its SequenceNumber
 *     ≤ the last applied one; the status only moves forward; a terminal status ends the call once;
 *   - voice: the opening is turn 0 (stored once, re-rendered on a replay);
 *   - gather: n < turn_count replays the stored lines (no new turn), n > turn_count is answered
 *     with the open question (nothing stored), n = turn_count is processed (UNIQUE (call, sequence));
 *   - amd: once; dial and whisper: only while a transfer is requested (the whisper's
 *     ParentCallSid must be the attempt's: the owner's leg is a child call); recording: only
 *     the call's own;
 *   - an ended call accepts nothing after lateEventGraceSeconds (answers <Hangup/>).
 */
import { TELEPHONY_WEBHOOK_LIMITS } from '@jarvis/contracts';
import { withContext, type DbContext } from '../../db/pool';
import type { CallSessionRow } from '../../db/types';
import type { DefineTelephonyWebhook } from '../../http/webhook-route';
import { AppError } from '../../lib/errors';
import { parsePhoneNumber } from '../../lib/phone';
import { asLocale } from '../agent/i18n';
import { detectInjection } from '../agent/tools/injection';
import { recordUsage } from '../agent/task-state';
import { enqueue } from '../jobs/queue';
import type { AppDeps } from '../../services';
import {
  adoptSid,
  advance,
  appendTurns,
  finalizeCall,
  lockCall,
  onBehalfOf,
  pastGrace,
  TERMINAL,
} from './calls';
import { nextTurn, render, storedLines, turnContext } from './dialog/engine';
import { openingLines } from './dialog/offline';
import { LINES, whisperLine } from './dialog/script';
import { analyse, type ApprovedCall } from './dialog/state';
import { recordDoNotCall } from './do-not-call';
import { createTelephonyGateway, type TelephonyGateway } from './gateway';
import { startCallRecording } from './recordings';
import * as twiml from './twilio/twiml';

const HANGUP = () => ({ twiml: twiml.response(twiml.hangup()) });
const EMPTY = { empty: true } as const;

const mismatch = () =>
  new AppError('FORBIDDEN', 'This webhook does not belong to this call', {
    reason: 'WEBHOOK_SIGNATURE_INVALID',
  });

async function load(deps: AppDeps, ctx: DbContext, id: string): Promise<CallSessionRow> {
  const row = await withContext(deps.db, ctx, (trx) =>
    trx.selectFrom('call_sessions').selectAll().where('id', '=', id).executeTakeFirst(),
  );
  if (!row) throw new AppError('NOT_FOUND', 'Route not found');
  return row;
}

/** The request's CallSid must be the attempt's (once known). */
function checkSid(row: CallSessionRow, sid: string): void {
  if (row.provider_call_sid && row.provider_call_sid !== sid) throw mismatch();
}

const answeredByOf = (v: string): 'human' | 'machine' | 'fax' | 'unknown' =>
  v.startsWith('machine') ? 'machine' : v === 'human' ? 'human' : v === 'fax' ? 'fax' : 'unknown';

/** RFC 2822 / ISO timestamp → Date, or null. */
const when = (v: string | undefined) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

export function registerCallWebhooks(deps: AppDeps, define: DefineTelephonyWebhook): void {
  const gateway = (): TelephonyGateway => {
    const gw = createTelephonyGateway(deps.config);
    if (!gw) throw new AppError('NOT_FOUND', 'Route not found');
    return gw;
  };

  /* --------------------------------- voice ---------------------------------- */
  define('twilioCallVoice', async ({ params, query, form, ctx }) => {
    const gw = gateway();
    const row = await load(deps, ctx, params.callId);
    checkSid(row, form.CallSid);
    if (row.status === 'ended') return HANGUP();
    const tc = await turnContext(deps, ctx, row);
    const result = await withContext(deps.db, ctx, async (trx) => {
      let r = (await lockCall(trx, row.id))!;
      if (r.status === 'ended') return null;
      r = await adoptSid(trx, ctx, r, form.CallSid);
      // Replay: the opening was stored already — the same lines again.
      if (r.turn_count > 0) return { row: r, ...storedLines(tc.turns, 0, tc.ownName, r.language) };
      r = await advance(trx, ctx, r, 'in_progress', {
        providerStatus: 'in-progress',
        sequence: null,
        answered: true,
      });
      // The opening (turn 0) says first that an AI assistant calls, and for whom.
      r =
        (await trx
          .updateTable('call_sessions')
          .set({ ai_disclosed_at: new Date() })
          .where('id', '=', r.id)
          .where('ai_disclosed_at', 'is', null)
          .returningAll()
          .executeTakeFirst()) ?? r;
      const input = r.request as unknown as ApprovedCall;
      const opening = openingLines({
        input,
        ownName: tc.ownName,
        turns: [],
        recordingConsent: r.recording_consent,
      });
      r = await appendTurns(
        trx,
        ctx,
        r,
        0,
        opening.lines.map((l) => ({ speaker: 'agent', kind: l.kind, text: l.text })),
      );
      return { row: r, lines: opening.lines, next: opening.next, nextSequence: r.turn_count };
    });
    if (!result) return HANGUP();
    return {
      twiml: render(result.lines, result.next, {
        gateway: gw,
        session: result.row,
        token: query.t,
        nextSequence: result.nextSequence,
        transferTo: tc.transferTo,
      }),
    };
  });

  /* --------------------------------- gather --------------------------------- */
  define('twilioCallGather', async ({ params, query, form, ctx, receivedAt }) => {
    const gw = gateway();
    const row = await load(deps, ctx, params.callId);
    checkSid(row, form.CallSid);
    if (row.status === 'ended') return HANGUP();
    const tc = await turnContext(deps, ctx, row);
    const n = query.n;
    const rendering = (r: CallSessionRow, s: ReturnType<typeof storedLines>) => ({
      twiml: render(s.lines, s.next, {
        gateway: gw,
        session: r,
        token: query.t,
        nextSequence: s.nextSequence,
        transferTo: tc.transferTo,
      }),
    });
    if (n < row.turn_count)
      return rendering(row, storedLines(tc.turns, n, tc.ownName, row.language));
    if (n > row.turn_count) {
      // Not the turn JARVIS is waiting for: ask the open question again (nothing stored).
      const input = row.request as unknown as ApprovedCall;
      const open = analyse({
        input,
        ownName: tc.ownName,
        turns: tc.turns,
        recordingConsent: row.recording_consent,
      }).openQuestion;
      return rendering(row, {
        lines: open ? [open] : [],
        next: open ? 'listen' : 'hangup',
        nextSequence: row.turn_count,
      });
    }
    const speech = form.SpeechResult?.trim();
    const confidence = form.Confidence !== undefined ? Number(form.Confidence) : NaN;
    const callee = speech
      ? {
          text: speech,
          confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : null,
        }
      : null;
    const decision = await nextTurn(deps, ctx, row, callee, tc, receivedAt);
    const scan = callee ? detectInjection(callee.text) : null;

    const stored = await withContext(deps.db, ctx, async (trx) => {
      let r = (await lockCall(trx, row.id))!;
      if (r.status === 'ended') return { kind: 'ended' as const };
      // Processed meanwhile (a duplicate delivered at the same time): the stored lines.
      if (r.turn_count !== n) return { kind: 'replay' as const, row: r };
      let seq = n;
      if (callee && decision.calleeKind) {
        r = await appendTurns(trx, ctx, r, seq, [
          {
            speaker: 'callee',
            kind: decision.calleeKind,
            text: callee.text,
            confidence: callee.confidence,
            flagged: scan?.suspectedInjection ?? false,
            injectionSignals: scan?.injectionSignals ?? [],
          },
        ]);
        seq++;
      }
      if (decision.confirmTurn !== null)
        await trx
          .updateTable('call_turns')
          .set({ kind: 'answer' })
          .where('call_session_id', '=', r.id)
          .where('sequence', '=', decision.confirmTurn)
          .where('speaker', '=', 'callee')
          .execute();
      r = await appendTurns(
        trx,
        ctx,
        r,
        seq,
        decision.lines.map((l) => ({ speaker: 'agent', kind: l.kind, text: l.text })),
      );
      const set: Record<string, unknown> = {};
      if (decision.consent && r.recording_consent === 'not_asked' && r.recording_mode !== 'off') {
        set.recording_consent = decision.consent;
        set.recording_consent_at = new Date();
      }
      if (decision.transfer && r.transfer_status === 'none') {
        set.transfer_status = decision.transfer;
        set.transfer_at = new Date();
      }
      if (Object.keys(set).length)
        r = await trx
          .updateTable('call_sessions')
          .set(set)
          .where('id', '=', r.id)
          .returningAll()
          .executeTakeFirstOrThrow();
      if (decision.optOut)
        await recordDoNotCall(trx, ctx, deps, {
          number: r.callee_number,
          source: 'callee_request',
          callId: r.id,
        });
      if (decision.usage.length) await recordUsage(trx, ctx, r.task_id, decision.usage);
      return { kind: 'stored' as const, row: r };
    });
    if (stored.kind === 'ended') return HANGUP();
    if (stored.kind === 'replay') {
      const turns = (await turnContext(deps, ctx, stored.row)).turns;
      return rendering(stored.row, storedLines(turns, n, tc.ownName, stored.row.language));
    }
    // Recording starts only now: after the callee's spoken consent was stored.
    if (decision.consent === 'accepted' && stored.row.provider_call_sid)
      await startCallRecording(deps, ctx, gw, stored.row, query.t);
    return {
      twiml: render(decision.lines, decision.next, {
        gateway: gw,
        session: stored.row,
        token: query.t,
        nextSequence: stored.row.turn_count,
        transferTo: tc.transferTo,
      }),
    };
  });

  /* --------------------------------- status --------------------------------- */
  define('twilioCallStatus', async ({ params, form, ctx, receivedAt }) => {
    const row = await load(deps, ctx, params.callId);
    checkSid(row, form.CallSid);
    if (pastGrace(row, receivedAt)) return EMPTY;
    const at = when(form.Timestamp);
    if (
      at &&
      receivedAt.getTime() - at.getTime() > TELEPHONY_WEBHOOK_LIMITS.maxEventAgeSeconds * 1000
    )
      return EMPTY;
    const seq = form.SequenceNumber !== undefined ? Number(form.SequenceNumber) : null;
    const sequence = seq !== null && Number.isInteger(seq) && seq >= 0 ? seq : null;
    await withContext(deps.db, ctx, async (trx) => {
      let r = (await lockCall(trx, row.id))!;
      if (
        sequence !== null &&
        r.last_status_sequence !== null &&
        sequence <= r.last_status_sequence
      )
        return;
      r = await adoptSid(trx, ctx, r, form.CallSid);
      if (r.provider_call_sid !== form.CallSid) return;
      const status = form.CallStatus;
      if (TERMINAL.has(status)) {
        if (form.AnsweredBy && !r.answered_by)
          r = await trx
            .updateTable('call_sessions')
            .set({ answered_by: answeredByOf(form.AnsweredBy) })
            .where('id', '=', r.id)
            .returningAll()
            .executeTakeFirstOrThrow();
        const seconds = form.CallDuration !== undefined ? Number(form.CallDuration) : NaN;
        await finalizeCall(trx, ctx, r, await onBehalfOf(trx, r), {
          providerStatus: status as 'completed',
          durationSeconds: Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds) : null,
          failureDetail: status === 'failed' ? (form.SipResponseCode ?? 'failed') : null,
          sequence,
          cancelledByJarvis: status === 'canceled',
        });
        return;
      }
      const to =
        status === 'ringing' ? 'ringing' : status === 'in-progress' ? 'in_progress' : 'dialing';
      await advance(trx, ctx, r, to, {
        providerStatus: status,
        sequence,
        answered: to === 'in_progress',
      });
    });
    return EMPTY;
  });

  /* ---------------------------------- amd ----------------------------------- */
  define('twilioCallAmd', async ({ params, form, ctx, req }) => {
    const gw = gateway();
    const row = await load(deps, ctx, params.callId);
    checkSid(row, form.CallSid);
    if (row.status === 'ended' || row.answered_by) return EMPTY;
    const by = answeredByOf(form.AnsweredBy);
    const outcome = await withContext(deps.db, ctx, async (trx) => {
      let r = (await lockCall(trx, row.id))!;
      if (r.answered_by || r.status === 'ended') return null;
      r = await adoptSid(trx, ctx, r, form.CallSid);
      r = await trx
        .updateTable('call_sessions')
        .set({ answered_by: by })
        .where('id', '=', r.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      if (by !== 'machine' && by !== 'fax') return null;
      const input = r.request as unknown as ApprovedCall;
      const message =
        by === 'machine' && input.voicemail === 'leave_message'
          ? input.script.voicemailMessage
          : null;
      if (message)
        r = await appendTurns(trx, ctx, r, r.turn_count, [
          { speaker: 'agent', kind: 'voicemail', text: message },
        ]);
      return { row: r, message };
    });
    if (outcome?.row.provider_call_sid) {
      // A machine (or fax) answered: leave the approved message, or hang up.
      const xml = outcome.message
        ? twiml.response(twiml.say(outcome.message, outcome.row.language), twiml.hangup())
        : twiml.response(twiml.hangup());
      try {
        await gw.updateCall(outcome.row.provider_call_sid, { twiml: xml });
      } catch (err) {
        // The provider's TimeLimit and the watchdog still end the call.
        req.log.warn(
          { err: String(err), callId: row.id },
          'telephony: could not update the call after AMD',
        );
      }
    }
    return EMPTY;
  });

  /* ---------------------------------- dial ---------------------------------- */
  define('twilioCallDial', async ({ params, form, ctx }) => {
    const row = await load(deps, ctx, params.callId);
    checkSid(row, form.CallSid);
    if (row.status === 'ended' || row.transfer_status !== 'requested') return HANGUP();
    // A leg that answered but was never bridged (the whisper hung it up) is not a transfer.
    const connected =
      (form.DialCallStatus === 'completed' || form.DialCallStatus === 'answered') &&
      form.DialBridged !== 'false';
    const tc = await turnContext(deps, ctx, row);
    const lines = await withContext(deps.db, ctx, async (trx) => {
      let r = (await lockCall(trx, row.id))!;
      if (r.transfer_status !== 'requested') return null;
      r = await trx
        .updateTable('call_sessions')
        .set({ transfer_status: connected ? 'connected' : 'failed' })
        .where('id', '=', r.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      if (connected) return [];
      const L = LINES[r.language];
      const input = r.request as unknown as ApprovedCall;
      const out = [
        { kind: 'transfer' as const, text: L.transferFailed(tc.ownName) },
        { kind: 'goodbye' as const, text: input.script.closing },
      ];
      await appendTurns(
        trx,
        ctx,
        r,
        r.turn_count,
        out.map((l) => ({ speaker: 'agent' as const, ...l })),
      );
      return out;
    });
    if (!lines || lines.length === 0) return HANGUP();
    return {
      twiml: twiml.response(...lines.map((l) => twiml.say(l.text, row.language)), twiml.hangup()),
    };
  });

  /* --------------------------------- whisper -------------------------------- */
  // <Number url> of a transfer: runs on the account owner's leg after they answer and before the
  // callee is bridged — who is calling and why, in the owner's language. Only for this call
  // (its sid is the parent of the owner's leg) and only while its transfer is requested;
  // anything else hangs up the owner's leg, so nobody is put through.
  define('twilioCallWhisper', async ({ params, form, ctx }) => {
    const row = await load(deps, ctx, params.callId);
    if (!row.provider_call_sid || row.provider_call_sid !== form.ParentCallSid) throw mismatch();
    if (row.status === 'ended' || row.transfer_status !== 'requested') return HANGUP();
    const owner = await withContext(deps.db, ctx, (trx) =>
      trx
        .selectFrom('users')
        .select('locale')
        .where('id', '=', row.user_id)
        .executeTakeFirstOrThrow(),
    );
    const lang = asLocale(owner.locale);
    const input = row.request as unknown as ApprovedCall;
    const who = row.callee_name ?? parsePhoneNumber(row.callee_number)?.international ?? row.callee_number;
    return { twiml: twiml.response(twiml.say(whisperLine(lang, who, input.goal), lang)) };
  });

  /* -------------------------------- recording ------------------------------- */
  define('twilioCallRecording', async ({ params, form, ctx }) => {
    const row = await load(deps, ctx, params.callId);
    checkSid(row, form.CallSid);
    if (pastGrace(row)) return EMPTY;
    // Only this call's own recording (started after the callee's consent) is ever fetched.
    if (
      !row.recording_sid ||
      row.recording_sid !== form.RecordingSid ||
      row.recording_consent !== 'accepted'
    )
      return EMPTY;
    if (form.RecordingStatus !== 'completed') return EMPTY;
    await withContext(deps.db, ctx, (trx) =>
      enqueue(trx, {
        kind: 'call.recording_fetch',
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        taskId: row.task_id,
        payload: { callId: row.id, recordingSid: form.RecordingSid },
        dedupeKey: `call-recording:${form.RecordingSid}`,
        maxAttempts: 5,
      }),
    );
    return EMPTY;
  });
}
