/**
 * TwiML builder (docs/architecture/phase-d.md §3.2–§3.3): the subset JARVIS answers voice,
 * gather and dial webhooks with — <Say> in the call's language with a neural voice of that
 * language, <Gather input="speech"> (barge-in on the question, the turn sequence in its
 * signed action URL), <Dial><Number> for a transfer to the account's own verified number,
 * <Hangup>. Every text and attribute is XML-escaped; nothing a callee said is ever echoed
 * into an attribute.
 */
import type { Locale } from '@jarvis/contracts';

/** <Say> language / voice and <Gather> speech-recognition language per call language. */
export const CALL_VOICES: Readonly<
  Record<Locale, { sayLanguage: string; voice: string; gatherLanguage: string }>
> = {
  en: { sayLanguage: 'en-US', voice: 'Polly.Joanna-Neural', gatherLanguage: 'en-US' },
  de: { sayLanguage: 'de-DE', voice: 'Polly.Vicki-Neural', gatherLanguage: 'de-DE' },
  // Arabic (MSA): Twilio's language code for Polly's Arabic voice is "arb".
  ar: { sayLanguage: 'arb', voice: 'Polly.Zeina', gatherLanguage: 'ar-SA' },
};

const ESC: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

/** Whether XML 1.0 allows the code point (tab, line feed, carriage return, and the valid ranges). */
const xmlChar = (cp: number) =>
  cp === 0x9 ||
  cp === 0xa ||
  cp === 0xd ||
  (cp >= 0x20 && cp <= 0xd7ff) ||
  (cp >= 0xe000 && cp <= 0xfffd) ||
  (cp >= 0x10000 && cp <= 0x10ffff);

/** XML-escapes text and attribute values; drops characters XML 1.0 does not allow. */
export function xmlEscape(text: string): string {
  let out = '';
  for (const ch of text) if (xmlChar(ch.codePointAt(0)!)) out += ch;
  return out.replace(/[&<>"']/g, (c) => ESC[c]!);
}

const attrs = (a: Record<string, string | number | undefined>) =>
  Object.entries(a)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => ` ${k}="${xmlEscape(String(v))}"`)
    .join('');

export type TwimlVerb = string;

export function say(text: string, language: Locale): TwimlVerb {
  const v = CALL_VOICES[language];
  return `<Say${attrs({ language: v.sayLanguage, voice: v.voice })}>${xmlEscape(text)}</Say>`;
}

export function pause(seconds = 1): TwimlVerb {
  return `<Pause${attrs({ length: seconds })}/>`;
}

/**
 * Listens for speech; the prompt lines are spoken inside the Gather (the callee may answer
 * while JARVIS is still speaking). actionOnEmptyResult: the action is requested even when
 * nothing was recognised, so silence is handled by the dialog engine (never a dead line).
 */
export function gather(opts: {
  action: string;
  language: Locale;
  prompt: readonly string[];
  /** Seconds to wait for the callee to start speaking. */
  timeoutSeconds?: number;
}): TwimlVerb {
  const v = CALL_VOICES[opts.language];
  return (
    `<Gather${attrs({
      input: 'speech',
      language: v.gatherLanguage,
      speechTimeout: 'auto',
      timeout: opts.timeoutSeconds ?? 6,
      actionOnEmptyResult: 'true',
      method: 'POST',
      action: opts.action,
    })}>` +
    opts.prompt.map((p) => say(p, opts.language)).join('') +
    `</Gather>`
  );
}

/**
 * Puts the callee through to `number` (the account's own verified number), showing `callerId`.
 * `whisperUrl` (<Number url>) is requested on the owner's leg after they answer and before the
 * callee is bridged: its TwiML tells them who is calling and why (or hangs up their leg).
 */
export function dial(opts: {
  number: string;
  callerId: string;
  timeoutSeconds: number;
  action: string;
  timeLimitSeconds: number;
  whisperUrl?: string;
}): TwimlVerb {
  return (
    `<Dial${attrs({
      callerId: opts.callerId,
      timeout: opts.timeoutSeconds,
      timeLimit: opts.timeLimitSeconds,
      action: opts.action,
      method: 'POST',
      answerOnBridge: 'true',
    })}>` +
    `<Number${opts.whisperUrl ? attrs({ url: opts.whisperUrl, method: 'POST' }) : ''}>${xmlEscape(opts.number)}</Number>` +
    `</Dial>`
  );
}

export const hangup = (): TwimlVerb => '<Hangup/>';

export function response(...verbs: TwimlVerb[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${verbs.join('')}</Response>`;
}
