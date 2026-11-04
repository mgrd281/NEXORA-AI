/**
 * The scripted dialog (offline, deterministic; docs/architecture/phase-d.md §3.2): given the
 * call so far and what the callee just said, the next lines JARVIS says — the approved script
 * and the fixed lines of script.ts only. The model dialog (model.ts) is consulted only where
 * this file says so (`askModel`), and its answer passes the guard; everything here — opt-out,
 * refusal, transfer, consent, personal-data refusal, duration and silence limits — always runs
 * first, whatever the dialog mode.
 *
 * Order for each utterance: duration limit → silence → opt-out / refusal to talk to an AI →
 * the recording question → a pending "Did you say …?" → low confidence → "who are you?" →
 * a person asked for → an approved detail asked for → anything else outside the purpose →
 * the answer to the open question.
 */
import { CALL_LIMITS, type CallTurnKind } from '@jarvis/contracts';
import {
  extractTimes,
  isNegative,
  isOptOut,
  isOutsidePurposeRequest,
  isPersonRequest,
  isQuestion,
  isRefusingAi,
  isWhoAreYou,
  shareInfoAsked,
  yesNo,
} from './rules';
import { LINES, spokenDate, spokenList, spokenTime, windowPhrase } from './script';
import { analyse, type DialogFacts, type DialogState } from './state';

export interface DialogLine {
  kind: CallTurnKind;
  text: string;
}

export interface DialogDecision {
  /** How the callee's utterance is stored (null: nothing recognised, no turn). */
  calleeKind: 'answer' | 'consent_reply' | 'statement' | null;
  /** An earlier low-confidence utterance the callee confirmed: stored as the answer. */
  confirmTurn: number | null;
  lines: DialogLine[];
  /** After the lines: listen again, hang up, or put the callee through. */
  next: 'listen' | 'hangup' | 'transfer';
  consent?: 'accepted' | 'declined';
  /** The callee asked not to be called again: a do-not-call entry for the number. */
  optOut?: boolean;
  transfer?: 'requested' | 'unavailable';
  /**
   * Model mode only: the model may answer instead ('question': the callee asked something the
   * script cannot answer; 'answer': the callee's answer needs understanding, e.g. agreeing an
   * appointment). These lines are the fallback when there is no model or the guard refuses.
   */
  askModel?: 'question' | 'answer';
}

export interface DecideContext extends DialogFacts {
  now: Date;
  answeredAt: Date | null;
  maxDurationSeconds: number;
  /** A transfer to the account's own verified number is approved and possible. */
  canTransfer: boolean;
}

export interface CalleeUtterance {
  text: string;
  confidence: number | null;
}

/** JARVIS's first lines once the callee picked up: the disclosure first, always. */
export function openingLines(f: DialogFacts): { lines: DialogLine[]; next: 'listen' } {
  const s = f.input.script;
  const lines: DialogLine[] = [{ kind: 'disclosure', text: s.opening }];
  if (s.recordingQuestion) lines.push({ kind: 'consent_request', text: s.recordingQuestion });
  else lines.push(...agendaStart(f));
  return { lines, next: 'listen' };
}

/** The script's first lines after the opening (and the recording question). */
function agendaStart(f: DialogFacts): DialogLine[] {
  const s = f.input.script;
  const out: DialogLine[] = [];
  if (s.message) out.push({ kind: 'statement', text: s.message });
  if (s.questions[0]) out.push({ kind: 'question', text: s.questions[0] });
  else out.push({ kind: 'goodbye', text: s.closing });
  return out;
}

const decision = (
  d: Partial<DialogDecision> & Pick<DialogDecision, 'lines' | 'next'>,
): DialogDecision => ({
  calleeKind: 'statement',
  confirmTurn: null,
  ...d,
});

function reask(st: DialogState, f: DialogFacts): DialogLine[] {
  if (st.openQuestion) return [{ kind: st.openQuestion.kind, text: st.openQuestion.text }];
  const q = f.input.script.questions[Math.max(0, st.qIndex)];
  return q ? [{ kind: 'question', text: q }] : [];
}

/** The next lines for this utterance (null = the callee said nothing JARVIS could recognise). */
export function decide(ctx: DecideContext, callee: CalleeUtterance | null): DialogDecision {
  const input = ctx.input;
  const lang = input.language;
  const L = LINES[lang];
  const n = ctx.ownName;
  const st = analyse(ctx);
  const goodbye = (text: string, extra: Partial<DialogDecision> = {}) =>
    decision({ lines: [{ kind: 'goodbye', text }], next: 'hangup', ...extra });

  // The approved maximum duration (20 s before it the closing is said).
  if (
    ctx.answeredAt &&
    ctx.now.getTime() - ctx.answeredAt.getTime() >= (ctx.maxDurationSeconds - 20) * 1000
  )
    return goodbye(L.durationEnd(n), { calleeKind: callee ? 'statement' : null });
  // At most CALL_LIMITS.maxTurns turns (room for this utterance and the closing).
  if (ctx.turns.length + 3 > CALL_LIMITS.maxTurns)
    return goodbye(input.script.closing, { calleeKind: callee ? 'statement' : null });

  if (!callee) {
    if (st.unclearStreak + 1 >= CALL_LIMITS.maxSilentPrompts)
      return goodbye(L.silenceEnd(), { calleeKind: null });
    return decision({
      calleeKind: null,
      lines: [{ kind: 'clarification', text: L.silence() }, ...reask(st, ctx)],
      next: 'listen',
    });
  }
  const text = callee.text;

  // A wish not to be called again (or not by an AI) is honoured at once, whatever else was said.
  if (isOptOut(text) || isRefusingAi(text)) return goodbye(L.optOut(), { optOut: true });

  // The recording question: only a clear yes records; anything unclear counts as no.
  if (st.consentPending) {
    if (isWhoAreYou(text))
      return decision({
        lines: [{ kind: 'disclosure', text: L.reDisclose(n) }, ...reask(st, ctx)],
        next: 'listen',
      });
    if (yesNo(text) === 'yes')
      return decision({
        calleeKind: 'consent_reply',
        consent: 'accepted',
        lines: [{ kind: 'statement', text: L.consentAccepted() }, ...agendaStart(ctx)],
        next: 'listen',
      });
    if (input.recording === 'required')
      return goodbye(L.consentRequiredEnd(n), { calleeKind: 'consent_reply', consent: 'declined' });
    return decision({
      calleeKind: 'consent_reply',
      consent: 'declined',
      lines: [{ kind: 'statement', text: L.consentDeclined() }, ...agendaStart(ctx)],
      next: 'listen',
    });
  }

  // "Did you say …?" — yes: the earlier words are the answer; no: ask again.
  if (st.pendingLowConfidence) {
    const yn = yesNo(text);
    if (yn === 'yes') {
      const d = answer(ctx, st, st.pendingLowConfidence.text);
      return { ...d, calleeKind: 'statement', confirmTurn: st.pendingLowConfidence.sequence };
    }
    if (yn === 'no') return decision({ lines: reask(st, ctx), next: 'listen' });
  }

  if (callee.confidence !== null && callee.confidence < CALL_LIMITS.minConfidence) {
    if (st.unclearStreak + 1 >= CALL_LIMITS.maxSilentPrompts) return goodbye(L.unclearEnd());
    return decision({
      lines: [{ kind: 'clarification', text: L.lowConfidence(text) }],
      next: 'listen',
    });
  }

  if (isWhoAreYou(text))
    return decision({
      lines: [{ kind: 'disclosure', text: L.reDisclose(n) }, ...reask(st, ctx)],
      next: 'listen',
    });

  if (isPersonRequest(text)) {
    if (ctx.canTransfer)
      return decision({
        transfer: 'requested',
        lines: [{ kind: 'transfer', text: L.transferring(n) }],
        next: 'transfer',
      });
    return decision({
      transfer: 'unavailable',
      lines: [{ kind: 'transfer', text: L.transferUnavailable(n) }, ...reask(st, ctx)],
      next: 'listen',
    });
  }

  const shared = shareInfoAsked(text, input.shareInfo);
  if (shared)
    return decision({
      lines: [{ kind: 'answer', text: L.share(shared.label, shared.value) }, ...reask(st, ctx)],
      next: 'listen',
    });

  if (isOutsidePurposeRequest(text))
    return decision({
      lines: [{ kind: 'refusal', text: L.outsidePurpose() }, ...reask(st, ctx)],
      next: 'listen',
    });

  return answer(ctx, st, text);
}

/** The callee's words as the answer to the open question. */
function answer(ctx: DecideContext, st: DialogState, text: string): DialogDecision {
  const input = ctx.input;
  const s = input.script;
  const lang = input.language;
  const L = LINES[lang];
  const unclear = (): DialogDecision =>
    st.unclearStreak + 1 >= CALL_LIMITS.maxSilentPrompts
      ? decision({ lines: [{ kind: 'goodbye', text: L.unclearEnd() }], next: 'hangup' })
      : decision({
          lines: [{ kind: 'clarification', text: L.notUnderstood() }, ...reask(st, ctx)],
          next: 'listen',
        });

  switch (input.purpose) {
    case 'message':
      if (isQuestion(text) && !isNegative(text))
        return {
          ...decision({
            lines: [{ kind: 'answer', text: L.unknownAnswer(ctx.ownName) }, ...reask(st, ctx)],
            next: 'listen',
          }),
          askModel: 'question',
        };
      return decision({
        calleeKind: 'answer',
        lines: [{ kind: 'goodbye', text: s.closing }],
        next: 'hangup',
      });
    case 'questions': {
      if (isQuestion(text) && yesNo(text) === 'unclear')
        return {
          ...decision({
            lines: [{ kind: 'answer', text: L.unknownAnswer(ctx.ownName) }, ...reask(st, ctx)],
            next: 'listen',
          }),
          askModel: 'question',
        };
      const next = s.questions[st.qIndex + 1];
      return decision({
        calleeKind: 'answer',
        lines: next
          ? [
              { kind: 'statement', text: L.ack() },
              { kind: 'question', text: next },
            ]
          : [{ kind: 'goodbye', text: s.closing }],
        next: next ? 'listen' : 'hangup',
      });
    }
    case 'availability':
    case 'appointment': {
      const date = input.date ? spokenDate(lang, input.date) : '';
      const times = extractTimes(text, input.window);
      if (times.length > 0) {
        const d = decision({
          calleeKind: 'answer',
          lines: [
            {
              kind: 'statement',
              text: L.readback(
                spokenList(
                  lang,
                  times.map((t) => spokenTime(lang, t)),
                ),
                date,
              ),
            },
            { kind: 'goodbye', text: s.closing },
          ],
          next: 'hangup',
        });
        // Agreeing a time is for the model behind the guard, and only for an appointment.
        return input.purpose === 'appointment' ? { ...d, askModel: 'answer' } : d;
      }
      // Only times outside the approved window: ask once for one inside it (never agree outside).
      if (input.window && extractTimes(text, null).length > 0) {
        if (!st.followUpAsked && date)
          return {
            ...decision({
              lines: [
                {
                  kind: 'question',
                  text: L.windowFollowUp(date, windowPhrase(lang, input.window)),
                },
              ],
              next: 'listen',
            }),
            askModel: input.purpose === 'appointment' ? 'answer' : undefined,
          };
        return decision({
          calleeKind: 'answer',
          lines: [
            { kind: 'statement', text: L.noTimes(date) },
            { kind: 'goodbye', text: s.closing },
          ],
          next: 'hangup',
        });
      }
      if (isNegative(text))
        return decision({
          calleeKind: 'answer',
          lines: [
            { kind: 'statement', text: L.noTimes(date) },
            { kind: 'goodbye', text: s.closing },
          ],
          next: 'hangup',
        });
      if (yesNo(text) === 'yes' && !st.followUpAsked && date)
        return decision({
          lines: [{ kind: 'question', text: L.followUpTimes(date) }],
          next: 'listen',
        });
      if (isQuestion(text)) return { ...unclear(), askModel: 'question' };
      return { ...unclear(), askModel: 'answer' };
    }
  }
}
