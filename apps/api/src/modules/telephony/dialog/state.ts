/**
 * The state of a call's dialog, derived from what was said (docs/architecture/phase-d.md §3.2).
 * Nothing but the stored turns, the approved input and a few call columns carries state: the
 * engine is a deterministic function of them, so a webhook replayed or delivered twice
 * computes the same thing, and the outcome of an ended call is computed from its evidence (the
 * turns) — never from a model's claim.
 */
import {
  CALL_LIMITS,
  type CallCollectedDetails,
  type CallNoteCode,
  type CallResult,
  type CallSpeaker,
  type CallTurnKind,
  type Locale,
  type PhoneCallInput,
  type RecordingConsent,
  type TaskErrorReason,
} from '@jarvis/contracts';
import { extractTimes, isNegative, referenceIn, yesNo } from './rules';
import { confirmationLine, LINES, spokenDate as spoken, windowPhrase } from './script';

export interface TurnView {
  sequence: number;
  speaker: CallSpeaker;
  kind: CallTurnKind;
  text: string;
  confidence: number | null;
  flagged: boolean;
}

/** An approved call input whose script is bound. */
export type ApprovedCall = PhoneCallInput & { script: NonNullable<PhoneCallInput['script']> };

export interface DialogFacts {
  input: ApprovedCall;
  /** Whom JARVIS calls for (the account's display name). */
  ownName: string;
  turns: readonly TurnView[];
  recordingConsent: RecordingConsent;
}

export interface DialogState {
  /** The recording question was asked and not answered yet. */
  consentPending: boolean;
  /** Index of the script question asked last (-1: none yet). */
  qIndex: number;
  /** The accepted answer to each script question. */
  answers: Map<number, TurnView>;
  /** The availability follow-up ("Which times …?") was asked. */
  followUpAsked: boolean;
  /** Consecutive prompts that got no usable answer (silence, not understood, low confidence). */
  unclearStreak: number;
  /** A low-confidence utterance waiting for "yes, that's what I said". */
  pendingLowConfidence: TurnView | null;
  /** The last line JARVIS asked (re-asked after a clarification). */
  openQuestion: { kind: CallTurnKind; text: string } | null;
  /** JARVIS ended the dialog (its last line was a goodbye / a transfer). */
  ended: boolean;
}

const agent = (t: TurnView) => t.speaker !== 'callee';

export function analyse(f: DialogFacts): DialogState {
  const L = LINES[f.input.language];
  const s = f.input.script;
  const date = f.input.date ? spoken(f.input.language, f.input.date) : null;
  const followUps = new Set(
    date
      ? [
          L.followUpTimes(date),
          L.windowFollowUp(date, windowPhrase(f.input.language, f.input.window)),
        ]
      : [],
  );
  const unclearTexts = new Set([L.silence(), L.notUnderstood()]);
  const state: DialogState = {
    consentPending: false,
    qIndex: -1,
    answers: new Map(),
    followUpAsked: false,
    unclearStreak: 0,
    pendingLowConfidence: null,
    openQuestion: null,
    ended: false,
  };
  const lowConfidencePrefix = L.lowConfidence('\u0000').split('\u0000')[0]!;
  let lastCallee: TurnView | null = null;
  let lastAgent: TurnView | null = null;
  for (const t of f.turns) {
    if (agent(t)) {
      lastAgent = t;
      if (t.kind === 'consent_request') {
        state.consentPending = true;
        state.openQuestion = { kind: t.kind, text: t.text };
      }
      if (t.kind === 'question') {
        const i = s.questions.indexOf(t.text);
        if (i >= 0) state.qIndex = i;
        if (followUps.has(t.text)) state.followUpAsked = true;
        state.openQuestion = { kind: t.kind, text: t.text };
      }
      if (t.kind === 'clarification') {
        if (unclearTexts.has(t.text) || t.text.startsWith(lowConfidencePrefix))
          state.unclearStreak++;
      }
      state.ended = t.kind === 'goodbye' || t.kind === 'transfer' || t.kind === 'voicemail';
      if (t.kind === 'transfer' && t.text !== L.transferring(f.ownName)) state.ended = false;
    } else {
      lastCallee = t;
      if (t.kind === 'consent_reply') {
        state.consentPending = false;
        state.unclearStreak = 0;
      }
      if (t.kind === 'answer') {
        if (state.qIndex >= 0 && !state.answers.has(state.qIndex))
          state.answers.set(state.qIndex, t);
        state.unclearStreak = 0;
      }
      // "Yes" to "Did you say …?" settles the unclear moment.
      if (
        lastAgent?.kind === 'clarification' &&
        lastAgent.text.startsWith(lowConfidencePrefix) &&
        yesNo(t.text) === 'yes'
      )
        state.unclearStreak = 0;
    }
  }
  if (f.recordingConsent !== 'not_asked') state.consentPending = false;
  const last = f.turns.at(-1);
  if (
    lastCallee &&
    lastCallee.kind === 'statement' &&
    lastCallee.confidence !== null &&
    lastCallee.confidence < CALL_LIMITS.minConfidence &&
    last &&
    agent(last) &&
    last.kind === 'clarification' &&
    last.text === L.lowConfidence(lastCallee.text)
  )
    state.pendingLowConfidence = lastCallee;
  return state;
}

/* ------------------------------------------------------------------ */
/* Outcome                                                             */
/* ------------------------------------------------------------------ */

export interface OutcomeFacts extends DialogFacts {
  /** How the provider ended the call. */
  providerStatus: 'completed' | 'busy' | 'no-answer' | 'failed' | 'canceled';
  /** The provider's SIP response / failure detail for failed calls. */
  failureDetail?: string | null;
  answeredBy: 'human' | 'machine' | 'fax' | 'unknown' | null;
  /** The voice webhook ran (the callee picked up and JARVIS spoke). */
  answered: boolean;
  transferStatus: 'none' | 'requested' | 'connected' | 'failed' | 'unavailable';
  /** JARVIS cancelled the call before it was answered (task cancelled, limits). */
  cancelledByJarvis: boolean;
}

export interface ComputedOutcome {
  result: CallResult;
  goalReached: boolean;
  details: CallCollectedDetails;
  notes: CallNoteCode[];
  /** TaskErrorReason stored as call_sessions.failure_reason (unsuccessful results only). */
  failureReason: TaskErrorReason | null;
  /** Detail of CALL_FAILED (the provider's status / SIP code). */
  failureParams: Record<string, string>;
}

export function collectedDetails(f: DialogFacts): CallCollectedDetails {
  const st = analyse(f);
  const input = f.input;
  const calleeAnswers = [...st.answers.entries()].sort((a, b) => a[0] - b[0]);
  const answerTexts = calleeAnswers.map(([, t]) => t.text);
  const timed = input.purpose === 'availability' || input.purpose === 'appointment';
  const times = timed
    ? [...new Set(answerTexts.flatMap((t) => extractTimes(t, input.window)))]
        .sort()
        .slice(0, CALL_LIMITS.maxCollectedTimes)
    : [];
  let appointment: CallCollectedDetails['appointment'] = null;
  if (input.purpose === 'appointment' && input.date) {
    // The confirmation JARVIS spoke (guard.ts: only for a time the callee offered in the window).
    const offered = [
      ...new Set(
        f.turns
          .filter((t) => t.speaker === 'callee')
          .flatMap((t) => extractTimes(t.text, input.window)),
      ),
    ];
    const spokenLines = new Map(f.turns.filter(agent).map((t) => [t.text, t.sequence]));
    for (const time of offered) {
      const seq = spokenLines.get(confirmationLine(input.language, f.ownName, input.date, time));
      if (seq === undefined) continue;
      const later = f.turns.filter((t) => t.speaker === 'callee' && t.sequence > seq);
      const before = f.turns.filter((t) => t.speaker === 'callee' && t.sequence < seq);
      const reference =
        [...later, ...before].map((t) => referenceIn(t.text)).find((r) => r !== null) ?? null;
      const named = input.shareInfo.find((i) =>
        /^(?:name|full name|vollständiger name|الاسم)$/i.test(i.label),
      );
      appointment = { date: input.date, time, name: named?.value ?? f.ownName, reference };
      break;
    }
  }
  return {
    date: timed ? input.date : null,
    times,
    appointment,
    reply: input.purpose === 'message' ? (st.answers.get(0)?.text ?? null) : null,
    answers:
      input.purpose === 'questions'
        ? input.questions.map((q, i) => ({ question: q, answer: st.answers.get(i)?.text ?? null }))
        : [],
  };
}

/** Whether the approved goal was reached — only with evidence in the turns. */
export function goalReached(f: DialogFacts, details: CallCollectedDetails): boolean {
  const input = f.input;
  const st = analyse(f);
  switch (input.purpose) {
    case 'message':
      return (
        input.script.message !== null &&
        f.turns.some((t) => agent(t) && t.text === input.script.message)
      );
    case 'availability':
      return details.times.length > 0 || [...st.answers.values()].some((t) => isNegative(t.text));
    case 'questions':
      return input.questions.length > 0 && details.answers.every((a) => a.answer !== null);
    case 'appointment':
      return details.appointment !== null;
  }
}

export function callNotes(f: OutcomeFacts): CallNoteCode[] {
  const L = LINES[f.input.language];
  const notes = new Set<CallNoteCode>();
  const agentTexts = new Set(f.turns.filter(agent).map((t) => t.text));
  if (agentTexts.has(L.optOut())) notes.add('OPTED_OUT');
  if (f.recordingConsent === 'accepted') notes.add('RECORDING_CONSENT_ACCEPTED');
  if (f.recordingConsent === 'declined') notes.add('RECORDING_CONSENT_DECLINED');
  if (f.transferStatus !== 'none') notes.add('TRANSFER_REQUESTED');
  if (f.transferStatus === 'connected') notes.add('TRANSFER_CONNECTED');
  if (f.transferStatus === 'failed') notes.add('TRANSFER_FAILED');
  if (f.transferStatus === 'unavailable') notes.add('TRANSFER_UNAVAILABLE');
  if (f.turns.some((t) => agent(t) && t.kind === 'refusal')) notes.add('OUTSIDE_PURPOSE_REFUSED');
  if (f.turns.some((t) => t.speaker === 'callee' && t.flagged)) notes.add('INJECTION_FLAGGED');
  if (
    f.turns.some(
      (t) =>
        t.speaker === 'callee' && t.confidence !== null && t.confidence < CALL_LIMITS.minConfidence,
    )
  )
    notes.add('LOW_CONFIDENCE');
  if (agentTexts.has(L.durationEnd(f.ownName))) notes.add('DURATION_LIMIT');
  if (f.turns.some((t) => agent(t) && t.kind === 'voicemail')) notes.add('VOICEMAIL_MESSAGE_LEFT');
  return [...notes];
}

/** The structured result of an ended call (CallOutcome without its summary line). */
export function computeOutcome(f: OutcomeFacts): ComputedOutcome {
  const L = LINES[f.input.language];
  const details = collectedDetails(f);
  const notes = callNotes(f);
  const reached = goalReached(f, details);
  const fail = (
    result: CallResult,
    reason: TaskErrorReason,
    params: Record<string, string> = {},
  ) => ({
    result,
    goalReached: false,
    details,
    notes,
    failureReason: reason,
    failureParams: params,
  });
  if (f.providerStatus === 'busy') return fail('busy', 'CALL_BUSY');
  if (f.providerStatus === 'no-answer') return fail('no_answer', 'CALL_NO_ANSWER');
  if (f.providerStatus === 'failed')
    return fail('failed', 'CALL_FAILED', f.failureDetail ? { status: f.failureDetail } : {});
  if (f.providerStatus === 'canceled' || (f.cancelledByJarvis && !f.answered))
    return {
      result: 'canceled',
      goalReached: false,
      details,
      notes,
      failureReason: null,
      failureParams: {},
    };
  if (f.answeredBy === 'machine') return fail('voicemail', 'CALL_VOICEMAIL');
  if (f.answeredBy === 'fax') return fail('failed', 'CALL_FAILED', { status: 'fax' });
  if (!f.answered) return fail('hung_up', 'CALL_HUNG_UP');
  const agentTexts = new Set(f.turns.filter(agent).map((t) => t.text));
  if (agentTexts.has(L.optOut())) return fail('declined', 'CALL_DECLINED');
  if (agentTexts.has(L.consentRequiredEnd(f.ownName)))
    return fail('declined', 'RECORDING_CONSENT_DECLINED');
  if (reached)
    return {
      result: 'completed',
      goalReached: true,
      details,
      notes,
      failureReason: null,
      failureParams: {},
    };
  const st = analyse(f);
  if (st.ended || f.transferStatus === 'connected')
    return {
      result: 'answered',
      goalReached: false,
      details,
      notes,
      failureReason: null,
      failureParams: {},
    };
  return fail('hung_up', 'CALL_HUNG_UP');
}

export type { Locale };
