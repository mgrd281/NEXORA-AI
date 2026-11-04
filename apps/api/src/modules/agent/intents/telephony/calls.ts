/**
 * Offline intents of phone calls (en/de/ar; docs/architecture/phase-d.md §3.2):
 *   "call <who> <number> and tell them …"                          phone.call purpose message
 *   "call <number> and ask whether they have an appointment free on <day> [between …]"
 *                                                                   phone.call purpose availability
 *   "call <number> and ask: …?"                                     phone.call purpose questions
 *   German "ruf <number> an und sag / frag …", Arabic "اتصل بـ<number> وقل / واسأل …".
 * Rules (see ../types.ts): the number only as the user wrote it (phoneNumbersInText with the
 * account number's country for national formats) — none → clarify phone_number; nothing to say
 * or ask → clarify call_goal; agreeing, moving or cancelling an appointment by phone is binding
 * and needs the model (offline: honest unsupported); the call language is the request's unless
 * the user names another; details JARVIS may share are only those the user wrote for the call
 * (their name / e-mail when they say so); recording, voicemail message and transfer only when
 * the user asked for them.
 */
import type { CallShareItem, Locale } from '@jarvis/contracts';
import { CALL_LIMITS } from '@jarvis/contracts';
import { parsePhoneNumber, phoneNumbersInText } from '../../../../lib/phone';
import { truncate } from '../../../../lib/redact';
import { msg } from '../../i18n';
import { asciiDigits, parseDays, parseTime } from '../integrations/dates';
import {
  clarify,
  objective,
  stepTitled,
  titled,
  type OfflineIntent,
  type OfflinePlanContext,
  type OfflinePlanResult,
} from '../types';

const POLITE =
  /^\s*(?:(?:please|pls|can\s+you|could\s+you|would\s+you|jarvis,?|hey\s+jarvis,?|bitte|kannst\s+du|könntest\s+du|würdest\s+du|من\s+فضلك|لو\s+سمحت|هل\s+يمكنك|ممكن)\s+)+/i;

const CALL_START: Record<Locale, RegExp> = {
  en: /^(?:call|phone|ring|dial|give\s+(?:a\s+)?call\s+to)\b/i,
  de: /^(?:ruf|rufe|telefonier\w*\s+mit)\b/i,
  ar: /^(?:اتصل|اتصلي|إتصل|اتّصل|كلّم|كلم|هاتف)/,
};
/** "Kannst du +49 … anrufen und …" — the verb at the end of the clause (German). */
const DE_ANRUFEN = /\banrufen\b/i;

export function isCallRequest(text: string): boolean {
  const c = text.replace(POLITE, '').trim();
  return (
    CALL_START.en.test(c) ||
    CALL_START.de.test(c) ||
    CALL_START.ar.test(c) ||
    (DE_ANRUFEN.test(c) && /^(?:\+|00|0|[a-zäöüß])/i.test(c) && /\b(?:und|,)\b|,/.test(c))
  );
}

const BINDING =
  /\b(?:book|make|schedule|reserve|move|reschedule|postpone|cancel|change|confirm)\b[^.?!]{0,40}\b(?:appointment|booking|reservation|table|slot)s?\b|\b(?:buch\w*|vereinbar\w*|verschieb\w*|absag\w*|sag\w*\s+\w*\s*ab|reservier\w*|storn\w*|bestätig\w*)\b[^.?!]{0,40}\b(?:termin\w*|reservierung|tisch)\b|\btermin\w*\b[^.?!]{0,40}\b(?:buchen|vereinbaren|verschieben|absagen|stornieren|reservieren)\b|(?:احجز|احجزي|حجز|أجّل|أجل|ألغ|الغ|غيّر|غير|انقل|ثبّت|ثبت)\s*(?:لي\s*)?(?:ال)?(?:موعد|حجز)/i;

const LANGUAGE_NAMED: [RegExp, Locale][] = [
  [/\b(?:in|auf)\s+(?:german|deutsch)\b|بالألمانية|باللغة\s+الألمانية/i, 'de'],
  [/\b(?:in|auf)\s+(?:english|englisch)\b|بالإنجليزية|بالانجليزية|باللغة\s+الإنجليزية/i, 'en'],
  [/\b(?:in|auf)\s+(?:arabic|arabisch)\b|بالعربية|باللغة\s+العربية/i, 'ar'],
];

const MESSAGE: RegExp[] = [
  /\b(?:and\s+)?(?:tell|let)\s+(?:them|him|her|the\s+[\p{L}-]+)?\s*(?:know\s+)?(?:that\s+)?(.{2,})$/iu,
  /\b(?:and\s+)?(?:say|pass\s+on|leave\s+(?:them\s+)?(?:a\s+)?message)\s*(?:that|:)?\s*(.{2,})$/iu,
  /\b(?:und\s+)?(?:sag|sage|richte|teil|teile)\s+(?:ihnen|ihm|ihr|der\s+[\p{L}-]+|dem\s+[\p{L}-]+)?\s*(?:aus|mit)?\s*,?\s*((?:dass\s+)?.{2,})$/iu,
  /(?:^|\s)و?(?:قل|قولي|أخبر|اخبر|أبلغ|ابلغ|بلّغ|بلغ)(?:هم|ه|ها)?(?:\s+(?:لهم|له|لها))?\s*(?:(?:أن|بأن|ان|بان)\s+)?(.{2,})$/u,
];

const AVAILABILITY: RegExp[] = [
  /\bask\b[^?]{0,30}\b(?:whether|if)\b[^?]{0,40}\b(?:have|has|got|is\s+there)\b[^?]{0,30}\b(?:appointments?|slots?|times?|anything|openings?|space|availability)\b/i,
  /\bask\b[^?]{0,30}\b(?:for|about)\s+(?:an?\s+)?(?:free\s+)?(?:appointment|slot|availability)\b/i,
  /\bfrag\w*\b[^?]{0,40}\bob\b[^?]{0,60}\btermin\w*\b|\bfrag\w*\b[^?]{0,30}\bnach\s+(?:einem\s+)?(?:freien\s+)?termin\w*\b/i,
  /اسأل\w*[^؟]{0,30}(?:إن|إذا|ان|اذا|ما\s+إذا)\s*(?:كان|كانت)?\s*(?:لديهم|لديه|لديها|عندهم|يوجد|هناك)\s*(?:أي\s+)?(?:موعد|مواعيد|وقت)/,
];

const QUESTIONS: RegExp[] = [
  /\b(?:and\s+)?ask\b\s*(?:them|him|her)?\s*[:,]?\s*(.+[?])\s*$/iu,
  /\b(?:und\s+)?frag\w*\b\s*(?:sie|ihn|ihr)?\s*[:,]?\s*(.+[?])\s*$/iu,
  /و?اسأل(?:هم|ه|ها)?\s*[:،,]?\s*(.+[؟?])\s*$/u,
];

/**
 * The part of a call request before what JARVIS is to say or ask: "call +49 … every Monday at 9"
 * of "… and ask: do you deliver on Sundays?". Only there can a timing phrase mean that the call
 * itself recurs — the offline planner asks its schedule intent on this part of a call request,
 * so the words of the message or the questions never turn the call into a schedule.
 */
export function callRequestHead(text: string): string {
  let cut = text.length;
  for (const re of [...MESSAGE, ...QUESTIONS, ...AVAILABILITY]) {
    const m = re.exec(text);
    if (m && m.index < cut) cut = m.index;
  }
  return text.slice(0, cut);
}

const RECORD =
  /\b(?:record\s+(?:the|this)?\s*call|zeichne\w*\s+(?:das\s+gespräch|den\s+anruf)\s+auf|(?:den\s+anruf|das\s+gespräch)\s+aufzeichnen)\b|سجّل\s+المكالمة|سجل\s+المكالمة/i;
const VOICEMAIL =
  /\bleave\s+a\s+(?:voice\s*mail|message)\s+if\b|\bhinterlass\w*\s+(?:eine\s+)?nachricht\b|اترك\s+رسالة/i;
const TRANSFER =
  /\b(?:put\s+(?:them|him|her)\s+through\s+to\s+me|transfer\s+(?:them|the\s+call)\s+to\s+me)\b|\bstell\w*\s+(?:sie|ihn|den\s+anruf)\s+(?:zu\s+mir\s+)?durch\b|\bverbinde\w*\s+(?:sie|ihn)\s+mit\s+mir\b|حوّل\w*\s+(?:المكالمة\s+)?(?:إليّ|إلي|الي)/i;
const SHARE_NAME =
  /\b(?:give|tell)\s+them\s+my\s+name\b|\bmeinen\s+namen\s+(?:nennen|sagen|angeben)\b|(?:أعطهم|اعطهم|أخبرهم\s+ب)\s*اسمي/i;
const SHARE_EMAIL =
  /\b(?:give|tell)\s+them\s+my\s+e-?mail\b|\bmeine\s+e-?mail(?:-adresse)?\s+(?:nennen|sagen|angeben)\b|(?:أعطهم|اعطهم)\s*(?:بريدي|عنواني\s+الإلكتروني)/i;

const PREPOSITION =
  /^(?:(?:at|on|under|via|the\s+number|number|bei|unter|der\s+nummer|die\s+nummer|nummer|على|بالرقم|الرقم|ب|بـ|رقم)\s+)+|(?:\s+(?:at|on|under|bei|unter|على|بالرقم|على\s+الرقم|ب))+$/i;

/** The callee as the user named them, between the verb and the number ("my dentist"), if any. */
function calleeNameOf(core: string, numberAt: number): string | null {
  const head = core
    .slice(0, numberAt)
    .replace(CALL_START.en, '')
    .replace(CALL_START.de, '')
    .replace(CALL_START.ar, '')
    .replace(/^\s*(?:بـ|ب)\s*/, '')
    .trim()
    .replace(PREPOSITION, '')
    .replace(/[,:]+$/, '')
    .trim();
  if (!head || head.length < 2) return null;
  // "call the number …", "اتصل بالرقم …": no name.
  if (
    /^(?:the\s+number|number|die\s+nummer|nummer|الرقم|رقم|على\s+الرقم|ال?رقم\s+التالي)$/i.test(
      head,
    )
  )
    return null;
  return truncate(head, 120);
}

/** Where the first written number starts (international or national form). */
function numberPosition(text: string): number {
  const m = /(?:\+|00)[1-9][\d\s()./-]{6,}|0[1-9][\d\s()./-]{5,}/.exec(asciiDigits(text));
  return m ? m.index : -1;
}

function afterNumber(text: string): string {
  const digits = asciiDigits(text);
  const m = /(?:\+|00)[1-9][\d\s()./-]{6,}\d|0[1-9][\d\s()./-]{5,}\d/.exec(digits);
  return m ? text.slice(m.index + m[0].length) : text;
}

function windowOf(text: string): { start: string; end: string } | null {
  const t = asciiDigits(text);
  const between =
    /\b(?:between|zwischen)\s+(.{1,20}?)\s+(?:and|und)\s+(.{1,20}?)(?:\s|$|[.,?!])/i.exec(t) ??
    /بين\s+(?:الساعة\s+)?(.{1,12}?)\s+و\s*(?:الساعة\s+)?(.{1,12}?)(?:\s|$|[.,؟!])/.exec(t);
  if (between) {
    const a = parseTime(
      /\d/.test(between[1]!) && !/[:.]|uhr|am|pm/i.test(between[1]!)
        ? `${between[1]} uhr`
        : between[1]!,
    );
    const b = parseTime(
      /\d/.test(between[2]!) && !/[:.]|uhr|am|pm/i.test(between[2]!)
        ? `${between[2]} uhr`
        : between[2]!,
    );
    if (a && b) {
      const fmt = (h: number, m: number) =>
        `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      let s = fmt(a.hour, a.minute);
      const e = fmt(b.hour < a.hour && b.hour < 12 ? b.hour + 12 : b.hour, b.minute);
      if (s >= e && a.hour < 12) s = fmt(a.hour, a.minute);
      if (s < e) return { start: s, end: e };
    }
  }
  if (/\b(?:in\s+the\s+morning|vormittags?|morgens)\b|صباح/i.test(t))
    return { start: '08:00', end: '12:00' };
  if (/\b(?:in\s+the\s+afternoon|nachmittags?)\b|بعد\s+الظهر|مساء/i.test(t))
    return { start: '12:00', end: '18:00' };
  return null;
}

function shareInfoOf(text: string, ctx: OfflinePlanContext, lang: Locale): CallShareItem[] {
  const out: CallShareItem[] = [];
  const L = { en: ['Name', 'E-mail'], de: ['Name', 'E-Mail'], ar: ['الاسم', 'البريد الإلكتروني'] }[
    lang
  ];
  if (SHARE_NAME.test(text) && ctx.ownName) out.push({ label: L[0]!, value: ctx.ownName });
  if (SHARE_EMAIL.test(text)) out.push({ label: L[1]!, value: ctx.ownEmail });
  return out.slice(0, CALL_LIMITS.maxShareInfo);
}

function plan(
  ctx: OfflinePlanContext,
  who: string,
  input: Record<string, unknown>,
): OfflinePlanResult {
  const lang = ctx.language;
  return {
    ok: true,
    plan: {
      ...titled(lang, msg('plan.call', { who })),
      ...objective(lang, msg('objective.call', { who })),
      steps: [
        { key: 's1', toolId: 'phone.call', ...stepTitled(lang, msg('step.call', { who })), input },
      ],
    },
  };
}

const unsupported = (): OfflinePlanResult => ({
  ok: false,
  code: 'PLANNER_UNSUPPORTED',
  reason: 'OFFLINE_UNSUPPORTED',
  message:
    'Agreeing, moving or cancelling an appointment by phone needs an AI model, which is not available right now.',
});

export const phoneCallIntent: OfflineIntent = {
  id: 'telephony.call',
  plan(request, ctx) {
    const text = request.trim();
    if (!isCallRequest(text)) return null;
    const core = text.replace(POLITE, '').trim();
    // A binding booking by phone needs the model (and its guard) — never improvised offline.
    if (BINDING.test(core)) return unsupported();
    const numbers = phoneNumbersInText(core, ctx.phoneRegion ?? null);
    if (numbers.length === 0) return clarify(ctx.language, ['phone_number']);
    const to = numbers[0]!;
    const at = numberPosition(core);
    const calleeName = at > 0 ? calleeNameOf(core, at) : null;
    const language = LANGUAGE_NAMED.find(([re]) => re.test(core))?.[1] ?? ctx.language;
    let rest = afterNumber(core)
      .replace(/^\s*(?:an\b|anrufen\b)/i, '')
      .trim();
    for (const [re] of LANGUAGE_NAMED) rest = rest.replace(re, ' ').replace(/\s+/g, ' ').trim();
    const zone = ctx.timeZone ?? 'UTC';
    const who = calleeName ?? parsePhoneNumber(to)?.international ?? to;
    const common = {
      to,
      calleeName,
      language,
      goal: truncate(
        rest.replace(/^(?:and|und|و)\s+/i, '').trim() || core,
        CALL_LIMITS.maxGoalChars,
      ),
      shareInfo: shareInfoOf(core, ctx, language),
      recording: RECORD.test(core) ? 'if_consented' : 'off',
      voicemail: VOICEMAIL.test(core) ? 'leave_message' : 'hang_up',
      allowTransfer: TRANSFER.test(core),
    };

    if (AVAILABILITY.some((re) => re.test(rest))) {
      const days = parseDays(rest, zone);
      const oneDay = days && days.to > days.from && daysBetween(days.from, days.to) === 1;
      if (!days || !oneDay) return clarify(ctx.language, ['date_time']);
      return plan(ctx, who, {
        ...common,
        purpose: 'availability',
        date: days.from,
        window: windowOf(rest.replace(days.matched, ' ')),
      });
    }
    for (const re of QUESTIONS) {
      const m = re.exec(rest);
      if (!m) continue;
      const questions = m[1]!
        .split(/(?<=[?؟])\s+/)
        .map((q) => q.trim())
        .filter((q) => q.length > 1)
        .slice(0, CALL_LIMITS.maxQuestions)
        .map((q) => truncate(q, CALL_LIMITS.maxQuestionChars));
      if (questions.length) return plan(ctx, who, { ...common, purpose: 'questions', questions });
    }
    for (const re of MESSAGE) {
      const m = re.exec(rest);
      if (!m) continue;
      const message = m[1]!
        .trim()
        .replace(/^["“„«]|["”“»]$/g, '')
        .trim();
      if (message.length < 2) continue;
      return plan(ctx, who, {
        ...common,
        purpose: 'message',
        message: truncate(message, CALL_LIMITS.maxMessageChars),
      });
    }
    return clarify(ctx.language, ['call_goal']);
  },
};

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}
