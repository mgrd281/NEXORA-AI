/**
 * Server-generated sentences.
 *
 * MESSAGES are sentences the server composes for the UI (offline plan and
 * step titles, approval summaries, result lines). They are stored and sent as
 * `{ key, params }` (contracts ServerMessage) so clients render them in the
 * viewer's locale; the text rendered here, in the request language, is the
 * stored fallback. CONTENT strings end up inside things JARVIS produces for
 * the user (the summary email), so they are always in the request language.
 *
 * Keep the German in "du" (see the product's address decision).
 */
import type {
  Locale,
  ServerMessage,
  ServerMessageKey,
  ServerMessageParam,
} from '@jarvis/contracts';

type Dict = Record<Locale, string>;

const MESSAGES = {
  // Offline plan titles
  'plan.summarize': {
    en: 'Summarize {host}',
    de: '{host} zusammenfassen',
    ar: 'تلخيص {host}',
  },
  'plan.summarizeEmail': {
    en: 'Summarize {host} and email it to you',
    de: '{host} zusammenfassen und dir mailen',
    ar: 'تلخيص {host} وإرساله إليك بالبريد',
  },
  'plan.remember': { en: 'Remember: {text}', de: 'Merken: {text}', ar: 'تذكّر: {text}' },
  'plan.emailSelf': {
    en: 'Email yourself: {text}',
    de: 'E-Mail an dich: {text}',
    ar: 'بريد إلى نفسك: {text}',
  },
  // Offline plan objectives
  'objective.summarize': {
    en: 'Read {url} and summarize it.',
    de: '{url} lesen und zusammenfassen.',
    ar: 'قراءة {url} وتلخيصها.',
  },
  'objective.summarizeEmail': {
    en: 'Read {url}, summarize it and email the summary to {email}.',
    de: '{url} lesen, zusammenfassen und die Zusammenfassung an {email} senden.',
    ar: 'قراءة {url} وتلخيصها وإرسال الملخص إلى {email}.',
  },
  'objective.remember': {
    en: 'Save a note to long-term memory.',
    de: 'Eine Notiz im Langzeitgedächtnis speichern.',
    ar: 'حفظ ملاحظة في الذاكرة طويلة المدى.',
  },
  'objective.emailSelf': {
    en: 'Send a note to {email}.',
    de: 'Eine Notiz an {email} senden.',
    ar: 'إرسال ملاحظة إلى {email}.',
  },
  // Offline step titles
  'step.fetch': { en: 'Read {host}', de: '{host} lesen', ar: 'قراءة {host}' },
  'step.summarize': {
    en: 'Summarize the page',
    de: 'Seite zusammenfassen',
    ar: 'تلخيص الصفحة',
  },
  'step.emailSummary': {
    en: 'Email the summary to you',
    de: 'Zusammenfassung an dich senden',
    ar: 'إرسال الملخص إليك',
  },
  'step.remember': {
    en: 'Save to memory',
    de: 'Im Gedächtnis speichern',
    ar: 'الحفظ في الذاكرة',
  },
  'step.emailNote': {
    en: 'Email the note to you',
    de: 'Notiz an dich senden',
    ar: 'إرسال الملاحظة إليك',
  },
  // Approval summaries
  'approval.email': {
    en: 'Send the email “{subject}” to {recipients}.',
    de: 'Die E-Mail „{subject}“ an {recipients} senden.',
    ar: 'إرسال البريد «{subject}» إلى {recipients}.',
  },
  'approval.generic': {
    en: 'Run “{title}” ({tool}).',
    de: '„{title}“ ausführen ({tool}).',
    ar: 'تنفيذ «{title}» ({tool}).',
  },
  'approval.recipientsMany': {
    en: '{count} recipients',
    de: '{count} Empfänger',
    ar: '{count} مستلمين',
  },
  // Result summaries
  'result.emailSent': {
    en: 'Sent “{subject}” to {recipients}.',
    de: '„{subject}“ an {recipients} gesendet.',
    ar: 'تم إرسال «{subject}» إلى {recipients}.',
  },
  'result.memorySaved': {
    en: 'Saved to memory: “{text}”.',
    de: 'Im Gedächtnis gespeichert: „{text}“.',
    ar: 'تم الحفظ في الذاكرة: «{text}».',
  },
  'result.declined': {
    en: 'You declined this action, so nothing was sent or changed: {action}',
    de: 'Du hast diese Aktion abgelehnt, daher wurde nichts gesendet oder geändert: {action}',
    ar: 'لقد رفضت هذا الإجراء، لذلك لم يتم إرسال أو تغيير أي شيء: {action}',
  },
  'result.cancelled': {
    en: 'Cancelled at your request.',
    de: 'Auf deinen Wunsch abgebrochen.',
    ar: 'تم الإلغاء بناءً على طلبك.',
  },
  'result.expired': {
    en: 'The approval request expired before you decided, so nothing was done.',
    de: 'Die Freigabeanfrage ist abgelaufen, bevor du entschieden hast; es wurde nichts ausgeführt.',
    ar: 'انتهت صلاحية طلب الموافقة قبل أن تقرر، لذلك لم يتم تنفيذ أي شيء.',
  },
} satisfies Record<ServerMessageKey, Dict>;

const CONTENT = {
  // Email content
  'email.summarySubject': {
    en: 'Summary: {title}',
    de: 'Zusammenfassung: {title}',
    ar: 'ملخص: {title}',
  },
  'email.source': { en: 'Source', de: 'Quelle', ar: 'المصدر' },
  'email.noteSubject': {
    en: 'Note from JARVIS',
    de: 'Notiz von JARVIS',
    ar: 'ملاحظة من JARVIS',
  },
  // Summary method notes (part of the summary email)
  'summary.extractiveNote': {
    en: 'Extractive summary: key sentences quoted from the page; no AI model was used.',
    de: 'Extraktive Zusammenfassung: wichtige Sätze aus der Seite zitiert; es wurde kein KI-Modell verwendet.',
    ar: 'ملخص استخلاصي: جمل رئيسية مقتبسة من الصفحة؛ لم يُستخدم أي نموذج ذكاء اصطناعي.',
  },
  'summary.modelNote': {
    en: 'Summarized by JARVIS with {model}.',
    de: 'Von JARVIS mit {model} zusammengefasst.',
    ar: 'لخّصه JARVIS باستخدام {model}.',
  },
} satisfies Record<string, Dict>;

const STRINGS: Record<MessageKey, Dict> = { ...MESSAGES, ...CONTENT };

export type ContentKey = keyof typeof CONTENT;
export type MessageKey = ServerMessageKey | ContentKey;

/** Exposed for the catalog test (every key in every locale, same placeholders). */
export const SERVER_STRINGS: Readonly<Record<MessageKey, Dict>> = STRINGS;

function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, name: string) =>
    name in vars ? String(vars[name]) : m,
  );
}

export function t(
  locale: Locale,
  key: MessageKey,
  vars: Record<string, string | number> = {},
): string {
  const dict: Dict = STRINGS[key];
  return fill(dict[locale] ?? dict.en, vars);
}

/** A server sentence as data: clients render it in the viewer's locale. */
export function msg(
  key: ServerMessageKey,
  params: Record<string, ServerMessageParam> = {},
): ServerMessage {
  return { key, params };
}

/** Renders a message (and nested messages in its params) in `locale`. */
export function render(locale: Locale, m: ServerMessage): string {
  const vars: Record<string, string | number> = {};
  for (const [name, v] of Object.entries(m.params))
    vars[name] = typeof v === 'object' ? render(locale, v) : v;
  const dict: Dict = MESSAGES[m.key];
  return fill(dict[locale] ?? dict.en, vars);
}

/** "I prefer aisle seats." → "I prefer aisle seats" (for titles and quotes inside a sentence). */
export function withoutFinalStop(text: string): string {
  return text.replace(/(?<![.…])[.。]$/u, '');
}

/** Stored JSON → message (tolerates rows written before messages existed). */
export function asMessage(value: unknown): ServerMessage | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as { key?: unknown; params?: unknown };
  if (typeof v.key !== 'string' || !(v.key in MESSAGES)) return null;
  const params = v.params && typeof v.params === 'object' ? v.params : {};
  return { key: v.key as ServerMessageKey, params: params as ServerMessage['params'] };
}

export function asLocale(value: string | null | undefined, fallback: Locale = 'en'): Locale {
  return value === 'en' || value === 'de' || value === 'ar' ? value : fallback;
}
