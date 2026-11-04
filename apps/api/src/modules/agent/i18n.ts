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

  // Phase B — offline plan titles (follow-ups, documents, schedules, questions)
  'plan.emailResult': {
    en: 'Email “{title}” to you',
    de: '„{title}“ an dich mailen',
    ar: 'إرسال «{title}» إليك بالبريد',
  },
  'plan.rememberResult': {
    en: 'Remember the result of “{title}”',
    de: 'Ergebnis von „{title}“ merken',
    ar: 'تذكّر نتيجة «{title}»',
  },
  'plan.summarizeDocument': {
    en: 'Summarize {name}',
    de: '{name} zusammenfassen',
    ar: 'تلخيص {name}',
  },
  'plan.schedule': { en: 'Schedule: {title}', de: 'Zeitplan: {title}', ar: 'جدولة: {title}' },
  'plan.clarify': {
    en: 'Question about your request',
    de: 'Rückfrage zu deiner Anfrage',
    ar: 'سؤال حول طلبك',
  },
  // Phase B — offline plan objectives
  'objective.emailResult': {
    en: 'Send the earlier result to {email}.',
    de: 'Das frühere Ergebnis an {email} senden.',
    ar: 'إرسال النتيجة السابقة إلى {email}.',
  },
  'objective.rememberResult': {
    en: 'Save the earlier result to long-term memory.',
    de: 'Das frühere Ergebnis im Langzeitgedächtnis speichern.',
    ar: 'حفظ النتيجة السابقة في الذاكرة طويلة المدى.',
  },
  'objective.summarizeDocument': {
    en: 'Read {name} and summarize it.',
    de: '{name} lesen und zusammenfassen.',
    ar: 'قراءة {name} وتلخيصه.',
  },
  'objective.schedule': {
    en: 'Create the schedule “{title}”.',
    de: 'Den Zeitplan „{title}“ anlegen.',
    ar: 'إنشاء الجدول «{title}».',
  },
  'objective.clarify': {
    en: 'Ask you for the information this request needs.',
    de: 'Dich nach den Angaben fragen, die für diese Anfrage fehlen.',
    ar: 'سؤالك عن المعلومات التي يحتاجها هذا الطلب.',
  },
  // Phase B — offline step titles
  'step.recall': {
    en: 'Get the earlier result',
    de: 'Früheres Ergebnis abrufen',
    ar: 'استرجاع النتيجة السابقة',
  },
  'step.emailResult': {
    en: 'Email it to you',
    de: 'An dich senden',
    ar: 'إرسالها إليك',
  },
  'step.summarizeDocument': {
    en: 'Summarize {name}',
    de: '{name} zusammenfassen',
    ar: 'تلخيص {name}',
  },
  'step.schedule': {
    en: 'Create the schedule',
    de: 'Zeitplan anlegen',
    ar: 'إنشاء الجدول',
  },
  'step.clarify': {
    en: 'Ask you for details',
    de: 'Bei dir nachfragen',
    ar: 'سؤالك عن التفاصيل',
  },
  // Phase B — approval summaries
  'approval.schedule': {
    en: 'Create the schedule “{title}”.',
    de: 'Den Zeitplan „{title}“ anlegen.',
    ar: 'إنشاء الجدول «{title}».',
  },
  'approval.memory': {
    en: 'Save to memory: “{text}”.',
    de: 'Im Gedächtnis speichern: „{text}“.',
    ar: 'الحفظ في الذاكرة: «{text}».',
  },
  // Phase B — result lines
  'result.scheduleCreated': {
    en: 'Created the schedule “{title}”.',
    de: 'Zeitplan „{title}“ angelegt.',
    ar: 'تم إنشاء الجدول «{title}».',
  },
  'result.documentSummarized': {
    en: 'Summarized {name}.',
    de: '{name} zusammengefasst.',
    ar: 'تم تلخيص {name}.',
  },
  // Phase B — clarifying questions (assistant.clarify)
  'question.emailContent': {
    en: 'What should the email say?',
    de: 'Was soll in der E-Mail stehen?',
    ar: 'ماذا ينبغي أن تتضمن الرسالة؟',
  },
  'question.recipient': {
    en: 'Who should receive it? Write their email address.',
    de: 'Wer soll sie bekommen? Schreib die E-Mail-Adresse dazu.',
    ar: 'من ينبغي أن يستلمها؟ اكتب عنوان بريده الإلكتروني.',
  },
  'question.url': {
    en: 'Which page should I read? Paste its link.',
    de: 'Welche Seite soll ich lesen? Füge den Link ein.',
    ar: 'أي صفحة تريد أن أقرأها؟ الصق رابطها.',
  },
  'question.document': {
    en: 'Which document do you mean? Attach the file.',
    de: 'Welches Dokument meinst du? Hänge die Datei an.',
    ar: 'أي مستند تقصد؟ أرفق الملف.',
  },
  'question.scheduleTime': {
    en: 'When should this run? For example: every Monday at 9:00.',
    de: 'Wann soll das laufen? Zum Beispiel: jeden Montag um 9:00.',
    ar: 'متى ينبغي أن يتم ذلك؟ على سبيل المثال: كل يوم اثنين الساعة 9:00.',
  },
  'question.targetLanguage': {
    en: 'Which language should I translate it into?',
    de: 'In welche Sprache soll ich es übersetzen?',
    ar: 'إلى أي لغة تريد أن أترجمه؟',
  },
  'question.previousResult': {
    en: 'There is no earlier result in this conversation I could use. What should I send or save?',
    de: 'In diesem Gespräch gibt es noch kein Ergebnis, das ich verwenden kann. Was soll ich senden oder speichern?',
    ar: 'لا توجد نتيجة سابقة في هذه المحادثة يمكنني استخدامها. ماذا تريد أن أرسل أو أحفظ؟',
  },
  'question.details': {
    en: 'Can you tell me more about what you need?',
    de: 'Kannst du genauer sagen, was du brauchst?',
    ar: 'هل يمكنك أن توضح ما تحتاجه بمزيد من التفصيل؟',
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
  // Phase B: document analysis method notes (part of results and emails)
  'document.extractiveNote': {
    en: 'Extractive summary: key sentences quoted from the document; no AI model was used.',
    de: 'Extraktive Zusammenfassung: wichtige Sätze aus dem Dokument zitiert; es wurde kein KI-Modell verwendet.',
    ar: 'ملخص استخلاصي: جمل رئيسية مقتبسة من المستند؛ لم يُستخدم أي نموذج ذكاء اصطناعي.',
  },
  'document.modelNote': {
    en: 'Analyzed by JARVIS with {model}.',
    de: 'Von JARVIS mit {model} ausgewertet.',
    ar: 'حلّله JARVIS باستخدام {model}.',
  },
  'document.truncatedNote': {
    en: 'Only the first {chars} characters of the document were read.',
    de: 'Nur die ersten {chars} Zeichen des Dokuments wurden gelesen.',
    ar: 'تمت قراءة أول {chars} حرف من المستند فقط.',
  },
  // Phase B: emailing an earlier result (follow-ups)
  'email.resultSubject': {
    en: 'From JARVIS: {title}',
    de: 'Von JARVIS: {title}',
    ar: 'من JARVIS: {title}',
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
