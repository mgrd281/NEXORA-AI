/**
 * Phone-call view model (pure, unit-tested): status and result wording, tones, what a call
 * collected, and the phone-number input of Settings › Profile.
 */
import type {
  CallCollectedDetails,
  CallResult,
  CallSession,
  CallStatus,
  CallSummary,
  TaskErrorReason,
} from '@jarvis/contracts';
import { E164PhoneNumber } from '@jarvis/contracts';
import type { Tone } from '@/components/ui/Badge';
import type { MessageKey } from '@/i18n/catalog';

/** Calls still connecting or talking (live captions, the "Live" badge). */
export function isLive(call: Pick<CallSummary, 'status'>): boolean {
  return call.status === 'dialing' || call.status === 'ringing' || call.status === 'in_progress';
}

const RESULT_TONE: Record<CallResult, Tone> = {
  completed: 'success',
  answered: 'neutral',
  busy: 'warning',
  no_answer: 'warning',
  failed: 'danger',
  voicemail: 'warning',
  hung_up: 'warning',
  declined: 'neutral',
  canceled: 'neutral',
};

const STATUS_TONE: Record<CallStatus, Tone> = {
  queued: 'neutral',
  dialing: 'accent',
  ringing: 'accent',
  in_progress: 'accent',
  ended: 'neutral',
  unknown: 'warning',
};

/** The pill of a call: its result once ended, else where it is. */
export function callPill(call: Pick<CallSummary, 'status' | 'result'>): {
  key: MessageKey;
  tone: Tone;
} {
  if (call.status === 'ended' && call.result) {
    return { key: `calls.result.${call.result}` as MessageKey, tone: RESULT_TONE[call.result] };
  }
  return { key: `calls.status.${call.status}` as MessageKey, tone: STATUS_TONE[call.status] };
}

/** How the callee is named: as the user named them, else the number. */
export function calleeLabel(call: Pick<CallSummary, 'calleeName' | 'toDisplay'>): string {
  return call.calleeName?.trim() || call.toDisplay;
}

/** The facts a call collected, in display order; empty when it collected nothing. */
export function collectedFacts(details: CallCollectedDetails): Array<
  | { kind: 'date'; date: string }
  | { kind: 'times'; times: string[] }
  | {
      kind: 'appointment';
      date: string;
      time: string;
      name: string | null;
      reference: string | null;
    }
  | { kind: 'reply'; text: string }
  | { kind: 'answers'; answers: Array<{ question: string; answer: string | null }> }
> {
  const out: ReturnType<typeof collectedFacts> = [];
  if (details.appointment) {
    out.push({ kind: 'appointment', ...details.appointment });
  } else if (details.date) {
    out.push({ kind: 'date', date: details.date });
    out.push({ kind: 'times', times: [...details.times].sort() });
  } else if (details.times.length > 0) {
    out.push({ kind: 'times', times: [...details.times].sort() });
  }
  if (details.reply) out.push({ kind: 'reply', text: details.reply });
  if (details.answers.length > 0) out.push({ kind: 'answers', answers: details.answers });
  return out;
}

/** Turns shown on the task page before "Show the whole call". */
export const TURNS_SHOWN = 12;

/** The task's call attempts, newest first (the latest is the one the step's state is about). */
export function attemptsNewestFirst(calls: readonly CallSession[]): CallSession[] {
  return [...calls].sort((a, b) => b.attempt - a.attempt || b.createdAt.localeCompare(a.createdAt));
}

/** Phase D failure reasons that come from a call (shown in the call card as "Why"). */
export const CALL_FAILURE_REASONS: ReadonlySet<TaskErrorReason> = new Set<TaskErrorReason>([
  'CALL_BUSY',
  'CALL_NO_ANSWER',
  'CALL_FAILED',
  'CALL_VOICEMAIL',
  'CALL_HUNG_UP',
  'CALL_DECLINED',
  'CALL_DURATION_LIMIT',
  'RECORDING_CONSENT_DECLINED',
  'CALL_STATE_UNKNOWN',
]);

const ARABIC_INDIC = /[٠-٩۰-۹]/g;

/**
 * A phone number as typed → E.164 candidate: spaces, dots, dashes and brackets dropped,
 * Arabic-Indic digits read as digits, a leading 00 as +. The server checks it is a real,
 * diallable number (PHONE_NUMBER_INVALID otherwise).
 */
export function normalizePhoneInput(text: string): string {
  const ascii = text.replace(ARABIC_INDIC, (d) => {
    const code = d.charCodeAt(0);
    return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
  });
  const compact = ascii.replace(/[\s.\-() ‎‏⁦-⁩]/g, '');
  return compact.startsWith('00') ? `+${compact.slice(2)}` : compact;
}

export function isE164(value: string): boolean {
  return E164PhoneNumber.safeParse(value).success;
}
