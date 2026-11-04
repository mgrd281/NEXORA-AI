/**
 * The deterministic guard in front of the model dialog (docs/architecture/phase-d.md §3.2, §5):
 * the model proposes, this file decides what is said.
 *   - confirm_appointment: only for purpose 'appointment', a time the CALLEE offered (rules on
 *     the callee's own words), on the approved date, inside the approved window — and the
 *     sentence is a template (confirmationLine), never model text;
 *   - ask / answer: the model's words only after checking they carry no personal data that is
 *     not an approved shareInfo value verbatim (numbers, e-mail addresses, IBAN / card
 *     digits, dates of birth, links), no commitment, no markup; else the scripted fallback;
 *   - transfer / decline / goodbye map to the fixed lines (transfer only where approved).
 * Nothing the callee says can widen any of this.
 */
import { CALL_LIMITS, type CallShareItem } from '@jarvis/contracts';
import type { DialogDecision, DialogLine } from './offline';
import { extractTimes, within } from './rules';
import { confirmationLine, LINES } from './script';
import type { ApprovedCall, TurnView } from './state';

export interface ModelDialogDecision {
  intent: 'ask' | 'answer' | 'confirm_appointment' | 'decline' | 'transfer' | 'goodbye';
  utterance: string;
  collected?: { date?: string | null; time?: string | null } | null;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const LINK = /\bhttps?:\/\/\S+|\bwww\.\S+/i;
// Three or more digits in a row (allowing separators inside): phone, IBAN, card, postcode, year.
const DIGIT_RUN = /\d(?:[\s./-]?\d){2,}/g;
const IBAN = /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]){10,30}\b/;
const MARKUP = /<\/?[a-z][^>]*>|\{\{|\}\}|```/i;
const COMMITMENT =
  /\b(?:i confirm|we confirm|confirmed|i agree|we agree|agreed|book it|i'?ll take it|we'?ll take it|i accept|we accept|i promise|guarantee|we will pay|i will pay|deal)\b|\b(?:ich bestätige|bestätigt|wir nehmen|abgemacht|einverstanden|ich verspreche|garantiere|wir zahlen|ich zahle|zugesagt|gebucht)\b|(?:أؤكد|نؤكد|موافق|اتفقنا|سنحجز|سندفع|أعدك|نضمن)/i;

const digitsOf = (s: string) => s.replace(/\D/g, '');

/**
 * Whether model text may be spoken: nothing that looks like personal data unless it is an
 * approved shareInfo value verbatim, no links, no markup, no commitment, within the length.
 */
export function guardUtterance(
  text: string,
  shareInfo: readonly CallShareItem[],
): { ok: true; text: string } | { ok: false; reason: string } {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return { ok: false, reason: 'empty' };
  if (t.length > CALL_LIMITS.maxAgentUtteranceChars) return { ok: false, reason: 'too_long' };
  if (MARKUP.test(t)) return { ok: false, reason: 'markup' };
  if (LINK.test(t)) return { ok: false, reason: 'link' };
  if (COMMITMENT.test(t)) return { ok: false, reason: 'commitment' };
  const allowed = shareInfo.map((i) => i.value);
  // Approved values verbatim are fine; remove them before looking for anything else.
  let rest = t;
  for (const v of allowed) rest = rest.split(v).join(' ');
  const allowedDigits = allowed.map(digitsOf).filter((d) => d.length >= 3);
  for (const m of rest.matchAll(EMAIL))
    if (!allowed.includes(m[0])) return { ok: false, reason: 'email' };
  if (IBAN.test(rest)) return { ok: false, reason: 'iban' };
  for (const m of rest.matchAll(DIGIT_RUN)) {
    const d = digitsOf(m[0]);
    // Clock times (9:30, 14.00) are not personal data.
    if (/^\d{1,2}[:.]\d{2}$/.test(m[0].trim())) continue;
    if (!allowedDigits.some((a) => a.includes(d))) return { ok: false, reason: 'number' };
  }
  return { ok: true, text: t };
}

export interface GuardContext {
  input: ApprovedCall;
  ownName: string;
  turns: readonly TurnView[];
  /** The callee's current utterance (not stored yet). */
  calleeText: string;
  canTransfer: boolean;
  /** The open question (re-asked after an answer the model gave). */
  reask: DialogLine[];
}

/**
 * What is said for a model decision, or null when the guard refuses (the caller then uses the
 * scripted fallback decision).
 */
export function guardDecision(
  m: ModelDialogDecision,
  g: GuardContext,
  fallback: DialogDecision,
): DialogDecision | null {
  const input = g.input;
  const L = LINES[input.language];
  switch (m.intent) {
    case 'confirm_appointment': {
      if (input.purpose !== 'appointment' || !input.date) return null;
      const date = m.collected?.date ?? null;
      const time = m.collected?.time ?? null;
      if (date !== input.date || !time || !/^\d{2}:\d{2}$/.test(time)) return null;
      if (input.window && !within(time, input.window)) return null;
      // Only a time the callee offered, in their own words (this utterance or before).
      const offered = new Set(
        [...g.turns.filter((t) => t.speaker === 'callee').map((t) => t.text), g.calleeText].flatMap(
          (t) => extractTimes(t, input.window),
        ),
      );
      if (!offered.has(time)) return null;
      return {
        ...fallback,
        askModel: undefined,
        calleeKind: fallback.calleeKind === null ? null : 'answer',
        lines: [
          {
            kind: 'statement',
            text: confirmationLine(input.language, g.ownName, input.date, time),
          },
          { kind: 'goodbye', text: input.script.closing },
        ],
        next: 'hangup',
      };
    }
    case 'ask':
    case 'answer': {
      const ok = guardUtterance(m.utterance, input.shareInfo);
      if (!ok.ok) return null;
      return {
        ...fallback,
        askModel: undefined,
        calleeKind: fallback.calleeKind === null ? null : 'statement',
        lines:
          m.intent === 'ask'
            ? [{ kind: 'question', text: ok.text }]
            : [{ kind: 'answer', text: ok.text }, ...g.reask],
        next: 'listen',
      };
    }
    case 'transfer':
      return {
        ...fallback,
        askModel: undefined,
        calleeKind: 'statement',
        transfer: g.canTransfer ? 'requested' : 'unavailable',
        lines: g.canTransfer
          ? [{ kind: 'transfer', text: L.transferring(g.ownName) }]
          : [{ kind: 'transfer', text: L.transferUnavailable(g.ownName) }, ...g.reask],
        next: g.canTransfer ? 'transfer' : 'listen',
      };
    case 'decline':
    case 'goodbye':
      return {
        ...fallback,
        askModel: undefined,
        calleeKind: fallback.calleeKind === null ? null : 'answer',
        lines: [{ kind: 'goodbye', text: input.script.closing }],
        next: 'hangup',
      };
  }
}
