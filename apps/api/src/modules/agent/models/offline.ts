/**
 * Offline planner: a deterministic, multilingual (en/de/ar) rules engine used
 * when no external model may be used. Milestone 1 intents:
 *
 *   summarize/read/open a URL [and email it to me]   → web.fetch → text.summarize [→ email.send to self]
 *   remember (that) X / merk dir X / تذكر أن X        → memory.save
 *   email me …: <text> / schick mir …: / أرسل لي …:   → email.send to self
 *
 * Phase B (docs/architecture/phase-b.md §3.1–3.5):
 *
 *   follow-ups   "email it to me" / "schick mir das" / "أرسله لي"  → conversation.recall → email.send to self
 *                "send it to <address>"                           → conversation.recall → email.send (approval)
 *                "remember that" / "merk dir das" / "تذكر ذلك"      → conversation.recall → memory.save (approval)
 *   answers      to the previous turn's clarifying question (email content, link, file, time, address)
 *   documents    "summarize the document" with an attached file → document.analyze [→ email.send to self]
 *   schedules    "every Monday at 9 summarize <url> …" → schedule.create (approval)
 *   questions    assistant.clarify when something essential is missing: "email me" without
 *                content, "summarize the page" without a link, a document without a file,
 *                "email it" without an earlier result, "send it to Bob" without an address,
 *                a schedule without a time.
 *
 * Phase C (docs/architecture/phase-c.md §4.2): the domain intents of
 * intents/integrations and intents/browser (email, calendar, booking,
 * shopping) are asked after the Phase B intents and before the Milestone 1 ones.
 *
 * Everything else fails with PLANNER_UNSUPPORTED (translation included: there
 * is no offline translator). Recipients are only ever the owner or an
 * address the user wrote; nothing here reads results or documents (it only
 * refers to them by id), so their content cannot change a plan.
 */
import type {
  AttachmentMediaType,
  Locale,
  MissingInfo,
  Recurrence,
  ServerMessage,
  TaskErrorReason,
  Weekday,
} from '@jarvis/contracts';
import { truncate } from '../../../lib/redact';
import { latestRecallable, type PriorTurn } from '../conversation-context';
import { msg, render, t, withoutFinalStop } from '../i18n';
import { browserIntents } from '../intents/browser';
import { integrationIntents } from '../intents/integrations';
import { callRequestHead, isCallRequest, telephonyIntents } from '../intents/telephony';
import type { Plan } from '../plan';
import type { ConnectionState } from '../tools/types';

/**
 * English developer fallback. Clients explain PLANNER_UNSUPPORTED /
 * OFFLINE_UNSUPPORTED in the viewer's locale and teach the offline commands
 * in that language (the composer's examples), so no command list is sent.
 */
export const OFFLINE_UNSUPPORTED_MESSAGE =
  'The offline planner (no AI model) cannot handle this request.';

export type OfflinePlanResult =
  | { ok: true; plan: Plan }
  | {
      ok: false;
      code: 'PLANNER_UNSUPPORTED';
      reason: TaskErrorReason;
      params?: Record<string, number>;
      message: string;
    };

/* ------------------------------------------------------------------ */
/* Language detection                                                  */
/* ------------------------------------------------------------------ */

const ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿ]/;
const GERMAN =
  /[äöüß]|\b(bitte|und|mir|mich|dass|fasse|zusammen|zusammenfassen|zusammenfassung|merk|merke|schick|schicke|sende|lies|öffne|die|der|das|ist|ich|eine?n?|nicht|auf|für)\b/i;
const ENGLISH =
  /\b(the|and|me|my|please|summari[sz]e|summary|remember|email|send|read|open|what|is|are|that|it|to)\b/i;

/** Best-effort request language: Arabic script, then German/English markers, then the fallback. */
export function detectLanguage(text: string, fallback: Locale): Locale {
  if (ARABIC.test(text)) return 'ar';
  const withoutUrls = text.replace(/https?:\/\/\S+/gi, ' ');
  const de = (withoutUrls.match(new RegExp(GERMAN.source, 'gi')) ?? []).length;
  const en = (withoutUrls.match(new RegExp(ENGLISH.source, 'gi')) ?? []).length;
  if (de === 0 && en === 0) return fallback;
  if (de > en) return 'de';
  if (en > de) return 'en';
  return fallback;
}

/* ------------------------------------------------------------------ */
/* Intent patterns                                                     */
/* ------------------------------------------------------------------ */

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+|\bwww\.[^\s<>"'`]+/i;
const TRAILING_PUNCT = /[.,;:!?)\]}'"»”’،؛؟]+$/;

// JS \b is ASCII-only, so words starting with umlauts and Arabic words are matched without it.
const SUMMARIZE =
  /\b(summari[sz]e|summary|sum\s+up|tl;?dr|digest|gist|recap|read|open|fetch|check\s+out|look\s+at|zusammenfass\w*|zusammen|lies|lese|lesen)\b|öffne|überblick|لخص|لخّص|تلخيص|ملخص|اقرأ|إقرأ|اقرا|افتح/i;

const EMAIL_TO_ME =
  /\b(e-?mail|mail|send|forward)\b[^.\n]{0,40}\b(me|myself)\b|\b(to\s+me|to\s+my\s+(inbox|email))\b|\b(schick|schicke|sende|send|maile|mail|leite)\w*\b[^.\n]{0,40}\b(mir|mich)\b|\b(an\s+mich|per\s+e-?mail|per\s+mail)\b|أرسل|ارسل|ابعث|أرسله|ارسله|ابعثه|بالبريد|إيميل|ايميل/i;

const REMEMBER: RegExp[] = [
  /^\s*(?:please\s+|pls\s+|hey\s+jarvis,?\s+|jarvis,?\s+)?(?:remember|memori[sz]e|don'?t\s+forget|keep\s+in\s+mind|note)\s*(?:,|:)?\s*(?:that\s+)?([\s\S]+)$/i,
  /^\s*(?:bitte\s+)?(?:merk|merke|merken\s+sie)\s+(?:dir|sich)\s*(?:,|:)?\s*(?:bitte\s+)?(?:,\s*)?(?:dass\s+)?([\s\S]+)$/i,
  /^\s*(?:bitte\s+)?(?:denk|denke)\s+daran\s*(?:,|:)?\s*(?:dass\s+)?([\s\S]+)$/i,
  /^\s*(?:من\s+فضلك\s+|رجاءً?\s+)?(?:تذكر|تذكّر|احفظ|إحفظ|تذكري)\s*(?:،|:)?\s*(?:أن|أنّ|ان)?\s+([\s\S]+)$/,
];

const EMAIL_NOTE: RegExp[] = [
  /^\s*(?:please\s+)?(?:e-?mail|mail|send)\s+(?:me|myself)\b([^:：\n]*)[:：]\s*([\s\S]+)$/i,
  /^\s*(?:bitte\s+)?(?:schick|schicke|sende|maile)\s+mir\b([^:：\n]*)[:：]\s*([\s\S]+)$/i,
  /^\s*(?:من\s+فضلك\s+)?(?:أرسل|ارسل|ابعث)\s+(?:لي|إلي|إليّ|الي)([^:：\n]*)[:：]\s*([\s\S]+)$/,
];

/**
 * Phase C: "email me via Gmail: …" — the account the user names in their own words sends it
 * (email.send `via`); without one, bind picks (SMTP first). Only the provider is taken from
 * the words, never an address.
 */
const EMAIL_VIA =
  /(?:^|\s+)(?:via|through|from|with|using|über|mit|per|von)\s+(?:my\s+|meine[mnr]?\s+)?(gmail|google|outlook|microsoft|hotmail)(?:\s+(?:account|konto|mail))?\b|\s*(?:عبر|من\s+خلال|باستخدام)\s+(?:حساب\s+|بريد\s+)?(gmail|google|outlook|microsoft|جوجل|غوغل|مايكروسوفت|أوتلوك)/i;

function emailVia(hint: string): { via: 'google' | 'microsoft' | null; rest: string } {
  const m = EMAIL_VIA.exec(hint);
  if (!m) return { via: null, rest: hint };
  const name = (m[1] ?? m[2] ?? '').toLowerCase();
  const via = /gmail|google|جوجل|غوغل/.test(name) ? 'google' : 'microsoft';
  return { via, rest: (hint.slice(0, m.index) + hint.slice(m.index + m[0].length)).trim() };
}

// Likes, dislikes, wishes and habits. JS \b is ASCII-only: umlaut words and Arabic need no \b.
const PREFERENCE =
  /\b(prefer|like|love|hate|dislike|favou?rite|always|never|allergic|vegetarian|vegan|want|wants|would\s+rather|rather\s+not)\b|\b(bevorzug\w*|mag|liebe|hasse|lieblings\w*|immer|nie|niemals|allergisch|lieber|gerne?)\b|möchte|أفضل|أفضّل|أحب|أكره|المفضل|دائما|دائمًا|أبدا|أريد|أرغب/i;
// German only: "will" is the future in English; a note that starts "keine …" is a rule
// ("keine Termine vor 10 Uhr"), while "ich habe keine …" mid-sentence is usually a fact.
const PREFERENCE_DE = /\b(will|willst|wollen)\b|^\s*keine?\b/i;

export function memoryKind(content: string, lang: Locale): 'preference' | 'fact' {
  if (PREFERENCE.test(content)) return 'preference';
  if (lang === 'de' && PREFERENCE_DE.test(content)) return 'preference';
  return 'fact';
}

/**
 * A note as it is kept: one line, first letter capitalised (not "iPhone"-style
 * words) and a final full stop, so "Merk dir, dass ich montags …" is stored as
 * "Ich montags …." like a note the user wrote themselves.
 */
export function normalizeNote(raw: string): string {
  let s = raw.trim().replace(/\s+/g, ' ');
  if (!s) return s;
  const [first, second] = [...s];
  if (
    first &&
    first !== first.toLocaleUpperCase() &&
    !(second && second !== second.toLocaleLowerCase())
  )
    s = first.toLocaleUpperCase() + s.slice(first.length);
  if (!/[.!?…؟。:;)\]"'”’»]$/u.test(s)) s = `${s}.`;
  return s;
}

const FILLER_SUBJECT =
  /^(?:(?:a|an|the|some)\s+)?(?:e-?mail|mail|note|message|reminder)?$|^(?:eine?n?\s+)?(?:e-?mail|mail|nachricht|notiz|erinnerung)?$|^(?:بريد(?:اً|ًا)?|رسالة|ملاحظة|تذكير)?$/i;

function cleanUrl(raw: string): string {
  let url = raw.replace(TRAILING_PUNCT, '');
  if (/^www\./i.test(url)) url = `https://${url}`;
  return url;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

const capitalize = (s: string) => (s ? s[0]!.toLocaleUpperCase() + s.slice(1) : s);

/* ------------------------------------------------------------------ */
/* Planner                                                             */
/* ------------------------------------------------------------------ */

// Server sentences are kept as messages too, so clients show them in the viewer's locale.
const titled = (lang: Locale, m: ServerMessage) => ({
  title: truncate(render(lang, m), 80),
  titleMessage: m,
});
const stepTitled = (lang: Locale, m: ServerMessage) => ({
  title: render(lang, m),
  titleMessage: m,
});
const objective = (lang: Locale, m: ServerMessage) => ({
  objective: render(lang, m),
  objectiveMessage: m,
});

/** A file the planner may refer to (by id; names are data). */
export interface PlanningAttachment {
  id: string;
  filename: string;
  mediaType: AttachmentMediaType;
  sizeBytes: number;
  pageCount: number | null;
  /** Attached to the current request (false: an earlier request of the conversation). */
  attachedToRequest: boolean;
}

export interface OfflinePlanContext {
  language: Locale;
  ownEmail: string;
  /**
   * Phase C: the account's display name (a booking form's "Full name" when the user does not
   * write another one). Never a recipient or a search term.
   */
  ownName?: string | null;
  /** Phase B: the owner's time zone (schedules). Default UTC. */
  timeZone?: string;
  /** Phase B: earlier turns of the conversation, oldest first. */
  conversation?: readonly PriorTurn[];
  /** Phase B: files of the conversation (current request's and earlier ones). */
  attachments?: readonly PlanningAttachment[];
  /** Phase C: the user's connections (no secrets), for intents that pick an account. */
  connections?: readonly ConnectionState[];
  /** Phase C: the isolated browser agent can run now. */
  browserAvailable?: boolean;
  /** Phase D: phone calls can be placed on this server (a telephony gateway is configured). */
  telephonyAvailable?: boolean;
  /**
   * Phase D: the default country (ISO alpha-2) of numbers written without a country code —
   * the country of the account's own phone number; null = only numbers with "+" / "00".
   */
  phoneRegion?: string | null;
  /** Phase D: the account has a verified phone number (a callee can be put through to it). */
  ownPhoneVerified?: boolean;
}

/**
 * Phase C: the domain intents, asked in this order (intents/*). Phase D: telephony before the
 * browser's (a phone booking names a number, a site booking a supported site).
 */
const DOMAIN_INTENTS = [...integrationIntents, ...telephonyIntents, ...browserIntents];

/** The Milestone 1 intents (memory, summarize a link, email me: <text>). */
function planBasic(request: string, ctx: OfflinePlanContext): OfflinePlanResult {
  const text = request.trim();
  const lang = ctx.language;

  // 1. Memory
  for (const re of REMEMBER) {
    const m = re.exec(text);
    if (!m) continue;
    const raw = m[1]!.trim().replace(/\s+/g, ' ');
    if (!raw) break;
    if (raw.length > 1000) {
      return {
        ok: false,
        code: 'PLANNER_UNSUPPORTED',
        reason: 'MEMORY_TOO_LONG',
        params: { max: 1000 },
        message: 'A memory can be at most 1000 characters long.',
      };
    }
    // The added full stop must not push a note over the limit.
    const normalized = normalizeNote(raw);
    const content = normalized.length <= 1000 ? normalized : raw;
    return {
      ok: true,
      plan: {
        ...titled(lang, msg('plan.remember', { text: withoutFinalStop(content) })),
        ...objective(lang, msg('objective.remember')),
        steps: [
          {
            key: 's1',
            toolId: 'memory.save',
            ...stepTitled(lang, msg('step.remember')),
            input: { content, kind: memoryKind(raw, lang) },
          },
        ],
      },
    };
  }

  // 2. Summarize a link (optionally email it to me)
  const urlMatch = URL_RE.exec(text);
  const notePattern = EMAIL_NOTE.some((re) => re.test(text));
  if (urlMatch && (SUMMARIZE.test(text.replace(urlMatch[0], ' ')) || !notePattern)) {
    const url = cleanUrl(urlMatch[0]);
    const host = hostOf(url);
    const withEmail = EMAIL_TO_ME.test(text.replace(urlMatch[0], ' '));
    const steps: Plan['steps'] = [
      {
        key: 's1',
        toolId: 'web.fetch',
        ...stepTitled(lang, msg('step.fetch', { host })),
        input: { url },
      },
      {
        key: 's2',
        toolId: 'text.summarize',
        ...stepTitled(lang, msg('step.summarize')),
        input: { text: '{{s1.text}}', title: '{{s1.title}}', language: lang },
      },
    ];
    if (withEmail) {
      steps.push({
        key: 's3',
        toolId: 'email.send',
        ...stepTitled(lang, msg('step.emailSummary')),
        input: {
          to: [ctx.ownEmail],
          subject: t(lang, 'email.summarySubject', { title: '{{s1.title}}' }),
          body: `{{s2.summary}}\n\n{{s2.methodNote}}\n${t(lang, 'email.source')}: {{s1.finalUrl}}`,
        },
      });
    }
    return {
      ok: true,
      plan: {
        ...titled(lang, msg(withEmail ? 'plan.summarizeEmail' : 'plan.summarize', { host })),
        ...objective(
          lang,
          withEmail
            ? msg('objective.summarizeEmail', { url, email: ctx.ownEmail })
            : msg('objective.summarize', { url }),
        ),
        steps,
      },
    };
  }

  // 3. Email me: <text>
  for (const re of EMAIL_NOTE) {
    const m = re.exec(text);
    if (!m) continue;
    const { via, rest } = emailVia(m[1]!);
    const hint = rest.trim().replace(/^(?:a|an|the|eine?n?)\s+/i, '');
    const body = m[2]!.trim();
    if (!body) break;
    const firstLine = body.split('\n')[0]!.trim();
    const subject = truncate(
      FILLER_SUBJECT.test(rest.trim()) || hint.length < 3 ? firstLine : capitalize(hint),
      120,
    );
    return {
      ok: true,
      plan: {
        ...titled(lang, msg('plan.emailSelf', { text: subject })),
        ...objective(lang, msg('objective.emailSelf', { email: ctx.ownEmail })),
        steps: [
          {
            key: 's1',
            toolId: 'email.send',
            ...stepTitled(lang, msg('step.emailNote')),
            input: {
              to: [ctx.ownEmail],
              subject: subject || t(lang, 'email.noteSubject'),
              body,
              ...(via ? { via } : {}),
            },
          },
        ],
      },
    };
  }

  return unsupported();
}

const unsupported = (): OfflinePlanResult => ({
  ok: false,
  code: 'PLANNER_UNSUPPORTED',
  reason: 'OFFLINE_UNSUPPORTED',
  message: OFFLINE_UNSUPPORTED_MESSAGE,
});

/* ------------------------------------------------------------------ */
/* Phase B: clarifying questions                                       */
/* ------------------------------------------------------------------ */

/** A one-step plan that asks the user (assistant.clarify) instead of guessing. */
export function clarifyPlan(lang: Locale, missing: MissingInfo[]): OfflinePlanResult {
  return {
    ok: true,
    plan: {
      ...titled(lang, msg('plan.clarify')),
      ...objective(lang, msg('objective.clarify')),
      steps: [
        {
          key: 's1',
          toolId: 'assistant.clarify',
          ...stepTitled(lang, msg('step.clarify')),
          input: { missing },
        },
      ],
    },
  };
}

/** What a plan asks for, when it is a clarifying question. */
export function clarifyMissing(result: OfflinePlanResult): MissingInfo[] | null {
  if (!result.ok) return null;
  const step = result.plan.steps[0];
  return result.plan.steps.length === 1 && step?.toolId === 'assistant.clarify'
    ? ((step.input.missing as MissingInfo[] | undefined) ?? null)
    : null;
}

/* ------------------------------------------------------------------ */
/* Phase B: follow-ups on an earlier result                            */
/* ------------------------------------------------------------------ */

const EMAIL_ADDRESS = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
// A bare reference to the earlier result (no content of its own).
const REF_EN = String.raw`(?:it|that|this|them|the\s+(?:result|summary|answer|translation|analysis|text|reply))`;
const REF_DE = String.raw`(?:es|das|dies|dieses|sie|ihn|die\s+zusammenfassung|das\s+ergebnis|die\s+antwort|die\s+übersetzung|den\s+text)`;
const REF_AR = String.raw`(?:ذلك|هذا|هذه|ذاك|النتيجة|الملخص|الإجابة|الاجابة|الترجمة|الرد)`;
const SELF_EN = String.raw`(?:me|myself)`;
const POLITE_TAIL =
  /[\s,]*(?:please|pls|thanks|thank\s+you|bitte|danke|من\s+فضلك|لو\s+سمحت|رجاء)?[\s.!?؟،]*$/i;
const POLITE_HEAD =
  /^\s*(?:(?:please|pls|can\s+you|could\s+you|would\s+you|jarvis,?|bitte|kannst\s+du|könntest\s+du|من\s+فضلك|هل\s+يمكنك|ممكن)\s+)+/i;

/** The request without courtesy words around it (for whole-message follow-up patterns). */
function core(text: string): string {
  return text.replace(POLITE_HEAD, '').replace(POLITE_TAIL, '').replace(/\s+/g, ' ').trim();
}

type ResultTarget = { kind: 'self' } | { kind: 'address'; address: string } | { kind: 'name' };

const VIA_MAIL = String.raw`(?:\s+(?:by|via|per)\s+e-?mail|\s+per\s+mail|\s+بالبريد)?`;
// "email it to me", "send me that", "forward the summary to bob@x.com", "send it to Bob"
const EMAIL_RESULT_EN = new RegExp(
  String.raw`^(?:e-?mail|mail|send|forward)(?:\s+${SELF_EN})?\s+${REF_EN}(?:\s+(?:to|for)\s+(.+?))?${VIA_MAIL}$`,
  'i',
);
// "schick mir das", "schick es mir", "sende das an bob@x.com", "leite das an Bob weiter"
const EMAIL_RESULT_DE = new RegExp(
  String.raw`^(?:schick|schicke|sende|send|maile|leite)(?:\s+(?:mir|mich))?\s+${REF_DE}(?:\s+(?:mir|an\s+mich))?(?:\s+an\s+(.+?))?(?:\s+per\s+(?:e-?mail|mail))?(?:\s+weiter)?$`,
  'i',
);
// "أرسله لي", "أرسل لي ذلك", "ابعث النتيجة إلى bob@x.com"
const EMAIL_RESULT_AR = new RegExp(
  String.raw`^(?:(?:أرسله|ارسله|ابعثه|أرسلها|ارسلها|ابعثها)(?:\s+(?:لي|إلي|إليّ|الي))?|(?:أرسل|ارسل|ابعث)\s+(?:لي\s+)?${REF_AR}(?:\s+(?:لي|إلي|إليّ))?)(?:\s+(?:إلى|الى|ل)\s*(.+?))?(?:\s+(?:بالبريد|عبر\s+البريد)(?:\s+الإلكتروني)?)?$`,
);

const SELF_WORDS = /^(?:me|myself|mir|mich|لي|إلي|إليّ|نفسي|بريدي)$/i;

function emailResultTarget(text: string): ResultTarget | null {
  const c = core(text);
  for (const re of [EMAIL_RESULT_EN, EMAIL_RESULT_DE, EMAIL_RESULT_AR]) {
    const m = re.exec(c);
    if (!m) continue;
    const target = m[1]?.trim().replace(/[.,;:!?؟،]+$/, '');
    if (!target || SELF_WORDS.test(target)) return { kind: 'self' };
    const address = EMAIL_ADDRESS.exec(target)?.[0];
    return address ? { kind: 'address', address } : { kind: 'name' };
  }
  return null;
}

// "remember that" / "merk dir das" / "تذكر ذلك" — and nothing else.
const REMEMBER_RESULT = new RegExp(
  String.raw`^(?:(?:remember|memori[sz]e|save|keep|note)\s+${REF_EN}|(?:merk|merke)\s+dir\s+${REF_DE}|(?:speicher|speichere)\s+${REF_DE}|(?:تذكر|تذكّر|احفظ|إحفظ)\s+${REF_AR})$`,
  'i',
);

/** The recalled earlier result, emailed (to the owner, or a literal address with approval). */
function emailResultPlan(
  lang: Locale,
  ctx: OfflinePlanContext,
  turn: PriorTurn,
  to: string,
): OfflinePlanResult {
  const self = to.toLowerCase() === ctx.ownEmail.toLowerCase();
  return {
    ok: true,
    plan: {
      ...titled(
        lang,
        self
          ? msg('plan.emailResult', { title: turn.titleMessage ?? turn.title })
          : msg('plan.forwardResult', { title: turn.titleMessage ?? turn.title, recipients: to }),
      ),
      ...objective(lang, msg('objective.emailResult', { email: to })),
      steps: [
        {
          key: 's1',
          toolId: 'conversation.recall',
          ...stepTitled(lang, msg('step.recall')),
          input: { taskId: turn.taskId },
        },
        {
          key: 's2',
          toolId: 'email.send',
          ...stepTitled(
            lang,
            self ? msg('step.emailResult') : msg('step.forwardResult', { recipients: to }),
          ),
          input: {
            to: [to],
            subject: t(lang, 'email.resultSubject', { title: '{{s1.title}}' }),
            body: '{{s1.text}}',
          },
        },
      ],
    },
  };
}

function rememberResultPlan(lang: Locale, turn: PriorTurn): OfflinePlanResult {
  return {
    ok: true,
    plan: {
      ...titled(lang, msg('plan.rememberResult', { title: turn.titleMessage ?? turn.title })),
      ...objective(lang, msg('objective.rememberResult')),
      steps: [
        {
          key: 's1',
          toolId: 'conversation.recall',
          ...stepTitled(lang, msg('step.recall')),
          input: { taskId: turn.taskId },
        },
        {
          key: 's2',
          toolId: 'memory.save',
          ...stepTitled(lang, msg('step.remember')),
          input: { content: '{{s1.excerpt}}', kind: 'fact' },
        },
      ],
    },
  };
}

/* ------------------------------------------------------------------ */
/* Phase B: documents                                                  */
/* ------------------------------------------------------------------ */

const DOC_WORDS =
  /\b(document|doc|file|attachment|attached|pdf|docx|word\s+file|dokument\w*|datei\w*|anhang|angehängte?\w*|anlage)\b|المستند|الملف|المرفق|الوثيقة|مستند|ملف/i;
const WHAT_IS_IN =
  /\b(what(?:'s|\s+is)\s+(?:in|this)|what\s+does\s+(?:it|this)\s+say|worum\s+geht|was\s+steht)\b|ما\s+محتوى|ماذا\s+يقول|عن\s+ماذا/i;
/**
 * A calendar or mailbox named in the request: "was steht in meinem Kalender" asks about the
 * calendar, not about a document, so WHAT_IS_IN alone must not read it as a document question.
 */
const DOMAIN_NOUNS =
  /\b(?:calendar|agenda|inbox|mailbox|kalender\w*|termine?|posteingang|postfach)\b|تقويم|التقويم|جدولي|بريدي|صندوق\s+الوارد/i;
const PAGE_WORDS =
  /\b(page|website|site|article|link|web\s*page|seite|webseite|artikel)\b|الصفحة|الموقع|المقال|الرابط/i;

function documentPlan(
  text: string,
  lang: Locale,
  ctx: OfflinePlanContext,
  files: readonly PlanningAttachment[],
): OfflinePlanResult {
  const picked = files.slice(0, 5);
  const names = picked.map((f) => f.filename).join(', ');
  const name = truncate(names, 60);
  const steps: Plan['steps'] = picked.map((f, i) => ({
    key: `s${i + 1}`,
    toolId: 'document.analyze' as const,
    ...stepTitled(lang, msg('step.summarizeDocument', { name: truncate(f.filename, 60) })),
    input: { attachmentId: f.id, mode: 'summary', language: lang },
  }));
  if (EMAIL_TO_ME.test(text)) {
    const body = picked
      .map((_, i) =>
        picked.length > 1
          ? `{{s${i + 1}.title}}\n{{s${i + 1}.result}}\n\n{{s${i + 1}.methodNote}}`
          : `{{s${i + 1}.result}}\n\n{{s${i + 1}.methodNote}}`,
      )
      .join('\n\n');
    steps.push({
      key: `s${picked.length + 1}`,
      toolId: 'email.send',
      ...stepTitled(lang, msg('step.emailSummary')),
      input: {
        to: [ctx.ownEmail],
        subject: t(lang, 'email.summarySubject', { title: '{{s1.title}}' }),
        body,
      },
    });
  }
  return {
    ok: true,
    plan: {
      ...titled(lang, msg('plan.summarizeDocument', { name })),
      ...objective(lang, msg('objective.summarizeDocument', { name })),
      steps,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Phase B: schedules                                                  */
/* ------------------------------------------------------------------ */

const WEEKDAY_WORDS: [Weekday, RegExp][] = [
  ['MO', /\b(?:mondays?|montags?)\b|(?:ال)?[إا]ثنين/i],
  ['TU', /\b(?:tuesdays?|dienstags?)\b|(?:ال)?ثلاثاء/i],
  ['WE', /\b(?:wednesdays?|mittwochs?)\b|(?:ال)?[أا]ربعاء/i],
  ['TH', /\b(?:thursdays?|donnerstags?)\b|(?:ال)?خميس/i],
  ['FR', /\b(?:fridays?|freitags?)\b|(?:ال)?جمعة/i],
  ['SA', /\b(?:saturdays?|samstags?|sonnabends?)\b|(?:ال)?سبت/i],
  ['SU', /\b(?:sundays?|sonntags?)\b|(?:ال)?[أا]حد/i],
];
const WEEKDAY_ALT = String.raw`(?:mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?|sundays?|montags?|dienstags?|mittwochs?|donnerstags?|freitags?|samstags?|sonnabends?|sonntags?|(?:يوم\s+)?(?:ال)?(?:[إا]ثنين|ثلاثاء|[أا]ربعاء|خميس|جمعة|سبت|[أا]حد))`;
const WEEKDAY_LIST = String.raw`${WEEKDAY_ALT}(?:\s*(?:,|and|und|&|و)\s*${WEEKDAY_ALT})*`;

const WEEKDAY_PLURAL_EN = String.raw`(?:mondays|tuesdays|wednesdays|thursdays|fridays|saturdays|sundays)`;
const WEEKDAY_PLURAL_LIST = String.raw`${WEEKDAY_PLURAL_EN}(?:\s*(?:,|and|&)\s*${WEEKDAY_PLURAL_EN})*`;
// German adverbs ("montags") are recurring on their own.
const WEEKDAY_ADVERB_DE = String.raw`(?:montags|dienstags|mittwochs|donnerstags|freitags|samstags|sonnabends|sonntags)`;
const WEEKDAY_ADVERB_LIST = String.raw`${WEEKDAY_ADVERB_DE}(?:\s*(?:,|und|&)\s*${WEEKDAY_ADVERB_DE})*`;

/**
 * Frequency phrases (the part of the request that is not the task). A
 * `strong` phrase is recurring by itself ("every Monday", "jeden Tag", "كل
 * يوم"): without a time JARVIS asks for one. A weak one is often just an
 * adjective ("the daily digest", "monthly report") and counts only with a time.
 */
const FREQ: {
  re: RegExp;
  kind: 'daily' | 'weekdays' | 'weekly' | 'monthly';
  strong: boolean;
}[] = [
  {
    re: /\b(?:every\s+(?:single\s+)?day|each\s+day|every\s+morning|every\s+evening|jeden\s+(?:tag|morgen|abend)|täglich|tagtäglich)\b|كل\s+يوم(?!\s+(?:ال)?(?:[إا]ثنين|ثلاثاء|[أا]ربعاء|خميس|جمعة|سبت|[أا]حد|عمل))|يوميا|يومياً/i,
    kind: 'daily',
    strong: true,
  },
  { re: /\bdaily\b/i, kind: 'daily', strong: false },
  {
    re: /\b(?:every\s+weekday|jeden\s+werktag|werktags)\b|كل\s+يوم\s+عمل/i,
    kind: 'weekdays',
    strong: true,
  },
  { re: /\b(?:on\s+weekdays|an\s+werktagen)\b|أيام\s+العمل/i, kind: 'weekdays', strong: false },
  {
    re: new RegExp(
      String.raw`\b(?:every|each)\s+${WEEKDAY_LIST}|\bon\s+${WEEKDAY_PLURAL_LIST}\b|\b(?:jeden|jede|immer)\s+${WEEKDAY_LIST}|(?:^|\s)${WEEKDAY_ADVERB_LIST}\b|كل\s+${WEEKDAY_LIST}`,
      'i',
    ),
    kind: 'weekly',
    strong: true,
  },
  {
    re: /\b(?:every\s+month|each\s+month|jeden\s+monat|monatlich)\b|كل\s+شهر|شهريا|شهرياً/i,
    kind: 'monthly',
    strong: true,
  },
  { re: /\bmonthly\b/i, kind: 'monthly', strong: false },
];
/** A recurring phrase JARVIS cannot run offline (another interval or unit): ask for the timing. */
const SCHEDULE_HINT =
  /\b(?:every|each)\s+(?:(?:other|second|third|two|three|four|five|six|\d+)\s+)?(?:days?|mornings?|evenings?|nights?|weeks?|weekends?|months?|years?|hours?|minutes?)\b|\b(?:hourly|jede[ns]?\s+(?:woche|wochenende|jahr|stunde|zweiten?\s+\w+)|stündlich|wöchentlich)\b|كل\s+(?:أسبوع|اسبوع|ساعة|سنة|عام)|أسبوعيا|اسبوعيا/i;

const ARABIC_DIGITS = /[٠-٩]/g;
const toAsciiDigits = (s: string) =>
  s.replace(ARABIC_DIGITS, (d) => String(d.charCodeAt(0) - 0x0660));

// "at 9", "at 9:30", "at 9am", "at 21:00", "um 9 Uhr", "um 9.30", "الساعة 9", "الساعة 9:30 مساءً"
const TIME_RE =
  /\b(?:at|um|gegen)\s+(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.|uhr)?(?![\d/])|(?:في\s+)?الساعة\s+(\d{1,2})(?:[:.](\d{2}))?(?:\s*(صباحا|صباحاً|مساء|مساءً|ظهرا|ظهراً))?/i;
// "on the 1st", "on the 15th", "am 1.", "am 15", "في اليوم 1", "on the last day"
const MONTH_DAY_RE =
  /\b(?:on\s+the\s+(\d{1,2})(?:st|nd|rd|th)?|am\s+(\d{1,2})\.?(?=\s|$))|في\s+اليوم\s+(\d{1,2})|يوم\s+(\d{1,2})/i;
const LAST_DAY_RE =
  /\b(?:on\s+the\s+last\s+day|am\s+letzten(?:\s+tag)?|letzten\s+tag)\b|(?:في\s+)?(?:اليوم\s+)?الأخير|آخر\s+يوم/i;

function parseTime(text: string): { time: string; span: [number, number] } | null {
  const m = TIME_RE.exec(text);
  if (!m) return null;
  let hour = Number(m[1] ?? m[4]);
  const minute = Number(m[2] ?? m[5] ?? 0);
  const suffix = (m[3] ?? m[6] ?? '').toLowerCase().replace(/\./g, '');
  if (suffix === 'pm' || /^مساء|^ظهر/.test(suffix)) hour = hour === 12 ? 12 : hour + 12;
  else if ((suffix === 'am' || /^صباح/.test(suffix)) && hour === 12) hour = 0;
  if (!Number.isInteger(hour) || hour > 23 || minute > 59) return null;
  const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  return { time, span: [m.index, m.index + m[0].length] };
}

interface ParsedSchedule {
  recurrence: Omit<Recurrence, 'timeZone'>;
  rest: string;
}

/** A schedule phrase + time in the request, or 'no_time' when it names a frequency without a time. */
function parseSchedule(raw: string): ParsedSchedule | 'no_time' | null {
  const text = toAsciiDigits(raw);
  let freq: {
    kind: (typeof FREQ)[number]['kind'];
    strong: boolean;
    span: [number, number];
    phrase: string;
  } | null = null;
  for (const f of FREQ) {
    const m = f.re.exec(text);
    if (m) {
      const start = m.index + (m[0].length - m[0].trimStart().length);
      freq = { kind: f.kind, strong: f.strong, span: [start, m.index + m[0].length], phrase: m[0] };
      break;
    }
  }
  if (!freq) return SCHEDULE_HINT.test(text) ? 'no_time' : null;
  const time = parseTime(text);
  if (!time) return freq.strong ? 'no_time' : null;
  const cut: [number, number][] = [freq.span, time.span];
  let recurrence: ParsedSchedule['recurrence'];
  switch (freq.kind) {
    case 'daily':
      recurrence = { frequency: 'daily', interval: 1, time: time.time };
      break;
    case 'weekdays':
      recurrence = {
        frequency: 'weekly',
        interval: 1,
        byWeekday: ['MO', 'TU', 'WE', 'TH', 'FR'],
        time: time.time,
      };
      break;
    case 'weekly': {
      const days = WEEKDAY_WORDS.filter(([, re]) => re.test(freq.phrase)).map(([d]) => d);
      if (days.length === 0) return 'no_time';
      recurrence = { frequency: 'weekly', interval: 1, byWeekday: days, time: time.time };
      break;
    }
    case 'monthly': {
      const last = LAST_DAY_RE.exec(text);
      const day = MONTH_DAY_RE.exec(text);
      let byMonthDay: number[];
      if (last) {
        byMonthDay = [-1];
        cut.push([last.index, last.index + last[0].length]);
      } else if (day) {
        const n = Number(day[1] ?? day[2] ?? day[3] ?? day[4]);
        if (n < 1 || n > 31) return 'no_time';
        byMonthDay = [n];
        cut.push([day.index, day.index + day[0].length]);
      } else return 'no_time';
      recurrence = { frequency: 'monthly', interval: 1, byMonthDay, time: time.time };
      break;
    }
  }
  // The task is the request without the timing phrases.
  let rest = text;
  for (const [a, b] of [...cut].sort((x, y) => y[0] - x[0]))
    rest = `${rest.slice(0, a)} ${rest.slice(b)}`;
  rest = rest
    .replace(/\s+/g, ' ')
    .replace(/^[\s,;:.\-–—]+|[\s,;:\-–—]+$/g, '')
    .replace(/^(?:and|und|then|dann|و)\s+/i, '')
    .trim();
  return { recurrence, rest };
}

function schedulePlan(
  text: string,
  lang: Locale,
  ctx: OfflinePlanContext,
): OfflinePlanResult | null {
  const parsed = parseSchedule(text);
  if (parsed === null) return null;
  if (parsed === 'no_time') return clarifyPlan(lang, ['schedule_time']);
  if (!parsed.rest) return clarifyPlan(lang, ['details']);
  // Each run is re-planned; offline, only propose what the offline planner can
  // run on its own (no conversation or files: a run starts fresh).
  const inner = planOffline(parsed.rest, {
    language: lang,
    ownEmail: ctx.ownEmail,
    timeZone: ctx.timeZone,
  });
  if (!inner.ok || clarifyMissing(inner)) return inner;
  if (inner.plan.steps.some((s) => s.toolId === 'schedule.create')) return unsupported();
  // The remainder of the user's sentence starts mid-sentence ("summarize …"): give it a
  // capital when it begins with an ordinary lower-case word (never a link or an address).
  const request = /^\p{Ll}\p{L}*\s/u.test(parsed.rest)
    ? parsed.rest.charAt(0).toLocaleUpperCase(lang) + parsed.rest.slice(1)
    : parsed.rest;
  const title = truncate(request, 80);
  return {
    ok: true,
    plan: {
      ...titled(lang, msg('plan.schedule', { title })),
      ...objective(lang, msg('objective.schedule', { title })),
      steps: [
        {
          key: 's1',
          toolId: 'schedule.create',
          ...stepTitled(lang, msg('step.schedule')),
          input: {
            title,
            request,
            recurrence: { ...parsed.recurrence, timeZone: ctx.timeZone ?? 'UTC' },
          },
        },
      ],
    },
  };
}

/* ------------------------------------------------------------------ */
/* Phase B: answers to a clarifying question                           */
/* ------------------------------------------------------------------ */

/** What the previous turn asked (stored with the turn, or re-derived from its request). */
function askedFor(turn: PriorTurn, ctx: OfflinePlanContext): MissingInfo[] {
  if (turn.missing?.length) return turn.missing;
  return (
    clarifyMissing(planOffline(turn.request, { language: ctx.language, ownEmail: ctx.ownEmail })) ??
    []
  );
}

function answerQuestion(
  text: string,
  lang: Locale,
  ctx: OfflinePlanContext,
  turns: readonly PriorTurn[],
): OfflinePlanResult | null {
  const question = turns.at(-1)!;
  const earlier = turns.slice(0, -1);
  const missing = askedFor(question, ctx);
  const again = (combined: string, extra: Partial<OfflinePlanContext> = {}) => {
    const r = planOffline(combined, { ...ctx, conversation: earlier, ...extra });
    // Asking the same thing again would loop: only take a real plan.
    return r.ok && !clarifyMissing(r) ? r : null;
  };
  switch (missing[0]) {
    case 'email_content': {
      const body = text.trim();
      // "email it to me" / "remember that" point at an earlier result: not the content.
      if (!body || emailResultTarget(body) || REMEMBER_RESULT.test(core(body))) return null;
      const subject = truncate(body.split('\n')[0]!.trim(), 120);
      return {
        ok: true,
        plan: {
          ...titled(lang, msg('plan.emailSelf', { text: subject })),
          ...objective(lang, msg('objective.emailSelf', { email: ctx.ownEmail })),
          steps: [
            {
              key: 's1',
              toolId: 'email.send',
              ...stepTitled(lang, msg('step.emailNote')),
              input: { to: [ctx.ownEmail], subject: subject || t(lang, 'email.noteSubject'), body },
            },
          ],
        },
      };
    }
    case 'url':
      return URL_RE.test(text) ? again(`${question.request} ${text}`) : null;
    case 'schedule_time':
      return again(`${question.request} ${text}`);
    case 'recipient':
      return EMAIL_ADDRESS.test(text) ? again(`${question.request} ${text}`) : null;
    case 'document':
      return (ctx.attachments ?? []).some((a) => a.attachedToRequest)
        ? again(question.request)
        : null;
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ */
/* Entry                                                               */
/* ------------------------------------------------------------------ */

const TRANSLATE = /\b(translat\w*|übersetz\w*|uebersetz\w*)\b|Übersetz\w*|ترجم|ترجمة|ترجمه/i;
const EMAIL_ME_BARE =
  /^(?:(?:e-?mail|mail|send|write)\s+(?:me|myself)(?:\s+(?:an?\s+)?(?:e-?mail|mail|note|message|reminder))?|(?:send|write)\s+(?:an?\s+)?(?:e-?mail|mail|note|message)\s+to\s+(?:me|myself)|(?:schick|schicke|sende|maile|schreib|schreibe)\s+mir(?:\s+(?:eine?n?\s+)?(?:e-?mail|mail|nachricht|notiz|erinnerung))?|(?:أرسل|ارسل|ابعث|اكتب)\s+(?:لي|إلي)(?:\s+(?:بريدا|بريدًا|بريداً|بريد|رسالة|ملاحظة|تذكيرا))?)$/i;

export function planOffline(request: string, ctx: OfflinePlanContext): OfflinePlanResult {
  const text = request.trim();
  const lang = ctx.language;
  const turns = ctx.conversation ?? [];
  const files = ctx.attachments ?? [];
  const current = files.filter((f) => f.attachedToRequest);

  // 1. An answer to the clarifying question JARVIS just asked.
  if (turns.at(-1)?.outcome === 'question') {
    const answered = answerQuestion(text, lang, ctx, turns);
    if (answered) return answered;
  }

  // 2. Follow-ups that point at an earlier result ("email it to me", "remember that").
  const emailTarget = emailResultTarget(text);
  if (emailTarget) {
    const turn = latestRecallable(turns);
    if (!turn) return clarifyPlan(lang, ['previous_result']);
    if (emailTarget.kind === 'name') return clarifyPlan(lang, ['recipient']);
    return emailResultPlan(
      lang,
      ctx,
      turn,
      emailTarget.kind === 'self' ? ctx.ownEmail : emailTarget.address,
    );
  }
  if (REMEMBER_RESULT.test(core(text))) {
    const turn = latestRecallable(turns);
    return turn ? rememberResultPlan(lang, turn) : clarifyPlan(lang, ['previous_result']);
  }

  // 3. Schedules ("every Monday at 9 …"): before anything that would run the task now. A call
  // request recurs only when its own words say so — never because of what JARVIS is to say or
  // ask on the call ("… and ask: do you deliver on Sundays?").
  if (
    !REMEMBER.some((re) => re.test(text)) &&
    (!isCallRequest(text) || parseSchedule(callRequestHead(text)) !== null)
  ) {
    const scheduled = schedulePlan(text, lang, ctx);
    if (scheduled) return scheduled;
  }

  // 4. Translation needs a model: say so honestly rather than doing something else.
  if (TRANSLATE.test(text) && !REMEMBER.some((re) => re.test(text))) return unsupported();

  // 5. Documents: a file attached to this request (or named, from earlier in the conversation).
  const hasUrl = URL_RE.test(text);
  const whatIsIn = WHAT_IS_IN.test(text) && (DOC_WORDS.test(text) || !DOMAIN_NOUNS.test(text));
  const docIntent = DOC_WORDS.test(text) || whatIsIn;
  const summarizeIntent = SUMMARIZE.test(text.replace(URL_RE, ' '));
  if (!hasUrl && current.length > 0 && (summarizeIntent || docIntent || !text)) {
    return documentPlan(text, lang, ctx, current);
  }
  if (!hasUrl && docIntent && (summarizeIntent || whatIsIn)) {
    const earlier = files.filter((f) => !f.attachedToRequest);
    return earlier.length > 0
      ? documentPlan(text, lang, ctx, [earlier.at(-1)!])
      : clarifyPlan(lang, ['document']);
  }

  // 5b. Phase C domain intents (email, calendar, booking, shopping): before the Milestone 1
  // intents, which would read any request with a link as "summarize this page".
  for (const intent of DOMAIN_INTENTS) {
    const planned = intent.plan(text, ctx);
    if (planned) return planned;
  }

  // 6. Milestone 1 intents.
  const basic = planBasic(text, ctx);
  if (basic.ok) return basic;

  // 7. Something essential is missing: ask instead of inventing.
  if (!hasUrl && summarizeIntent && PAGE_WORDS.test(text)) return clarifyPlan(lang, ['url']);
  if (EMAIL_ME_BARE.test(core(text))) return clarifyPlan(lang, ['email_content']);
  return basic;
}
