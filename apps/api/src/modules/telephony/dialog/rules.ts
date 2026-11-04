/**
 * Deterministic understanding of what a callee says (en/de/ar), used by the scripted dialog
 * and in front of the model (docs/architecture/phase-d.md §3.2, docs/security/telephony.md §4):
 * opt-outs ("don't call again", "nicht mehr anrufen", "لا تتصل مرة أخرى"), refusals to talk
 * to an AI, requests for a person, "who are you?", requests for personal data or for anything
 * outside the call's purpose, yes / no (recording consent: anything unclear counts as no),
 * times of day ("9:30", "half past nine", "um 14 Uhr", "halb zehn", "الساعة الثانية والنصف"),
 * "nothing free", and a booking reference. Callee speech is untrusted: these rules only ever
 * classify it — nothing in it can add a step, change the number, the purpose, an amount or
 * what may be shared.
 */
import type { CallShareItem, Locale } from '@jarvis/contracts';

/** Lower case, Arabic-Indic digits → ASCII, Arabic diacritics / tatweel and Latin accents removed, quotes unified. */
export function normalise(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[\u0623\u0625\u0622]/g, '\u0627')
    .replace(/\u0649/g, '\u064A')
    .replace(/\u0629/g, '\u0647')
    .replace(/[\u2019`\u00B4]/g, "'")
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Without Latin diacritics (ä → a), for word lists written either way. */
const fold = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

const any = (patterns: readonly RegExp[], text: string) => patterns.some((p) => p.test(text));

/* ------------------------------ opt-out, refusal ------------------------------ */

const OPT_OUT: readonly RegExp[] = [
  // en
  /\b(?:don'?t|do not|never|please don'?t)\s+(?:ever\s+)?call\s+(?:me|us|here|this number)?\s*(?:again|any ?more)\b/,
  /\b(?:don'?t|do not)\s+call\s+(?:me|us|this number)\b/,
  /\bstop\s+calling\b/,
  /\b(?:take|remove|delete)\s+(?:me|us|this number|my number|our number)\s+(?:off|from)\s+(?:your|the)\s+(?:list|database|records?)\b/,
  /\b(?:no|don'?t want any)\s+more\s+calls\b/,
  // de
  /\bnicht\s+(?:mehr|wieder)\s+an(?:rufen|zurufen)?\b/,
  /\bruf(?:en)?\s+sie\s+(?:hier\s+|mich\s+|uns\s+)?(?:nie\s+)?(?:nicht\s+)?(?:mehr|wieder)\s+an\b/,
  /\bhor(?:en)?\s+sie\s+auf,?\s+(?:hier\s+|mich\s+|uns\s+)?anzurufen\b/,
  /\bkeine\s+anrufe\s+mehr\b/,
  /\bnie\s+wieder\s+anrufen\b/,
  /\b(?:streichen|loschen|entfernen)\s+sie\s+(?:mich|uns|meine nummer|unsere nummer|diese nummer)\b/,
  // ar
  /لا\s+(?:تتصل|تتصلوا|تتصلي)(?:\s+(?:بي|بنا|بهذا الرقم))?\s+(?:مره\s+اخري|مجددا|ثانيه|بعد\s+الان)/,
  /لا\s+(?:تتصلوا|تتصل)\s+(?:بي|بنا)/,
  /(?:توقف|توقفوا|كف|كفوا)\s+عن\s+الاتصال/,
  /(?:احذف|احذفوا|امسح|امسحوا)\s+(?:رقمي|رقمنا|هذا الرقم)/,
  /لا\s+(?:نريد|اريد)\s+(?:اي\s+)?(?:اتصالات|مكالمات)/,
];

const REFUSE_AI: readonly RegExp[] = [
  /\b(?:don'?t|do not|won'?t|will not|refuse to)\s+(?:want\s+to\s+)?(?:talk|speak)\s+(?:to|with)\s+(?:a |an )?(?:robot|machine|computer|bot|ai|artificial intelligence)s?\b/,
  /\bno\s+(?:robots|machines|bots)\b/,
  /\b(?:spreche|rede|sprechen|reden)\s+(?:ich\s+|wir\s+)?nicht\s+mit\s+(?:einem\s+|einer\s+)?(?:roboter|maschine|computer|ki|bot)\b/,
  /\bkeine\s+(?:roboter|maschinen|ki)\b/,
  /لا\s+(?:اريد|نريد|اتحدث|نتحدث|اتكلم|نتكلم)\s+(?:التحدث\s+|الكلام\s+)?(?:مع|الي)\s+(?:اله|الات|روبوت|كمبيوتر|حاسوب|ذكاء\s+اصطناعي)/,
];

/** The callee asked not to be called again (do-not-call entry, apology, hang up). */
export const isOptOut = (text: string): boolean => {
  const n = normalise(text);
  return any(OPT_OUT, n) || any(OPT_OUT, fold(n));
};

/** The callee does not want to talk to an AI assistant (honoured like an opt-out). */
export const isRefusingAi = (text: string): boolean => {
  const n = normalise(text);
  return any(REFUSE_AI, n) || any(REFUSE_AI, fold(n));
};

/* ------------------------------ person, identity ------------------------------ */

const PERSON: readonly RegExp[] = [
  /\b(?:speak|talk)\s+(?:to|with)\s+(?:a |an |the )?(?:real\s+)?(?:person|human|someone|somebody|her|him|them|manager|owner)\b/,
  /\bput\s+me\s+through\b/,
  /\b(?:connect|transfer)\s+me\b/,
  /\bis\s+(?:she|he)\s+(?:there|available)\b/,
  /\breal\s+person\b/,
  /\b(?:mit\s+)?(?:einem\s+menschen|einer\s+person|ihr|ihm|jemandem|der person)\s+(?:selbst\s+|personlich\s+)?sprechen\b/,
  /\bverbinden\s+sie\s+mich\b/,
  /\bpersonlich\s+sprechen\b/,
  /\bist\s+(?:sie|er)\s+(?:da|zu\s+sprechen|erreichbar)\b/,
  /(?:اريد|اود|نريد|ممكن|هل\s+يمكنني)\s+(?:التحدث|الكلام|التكلم)\s+(?:مع|الي)\s+(?:شخص|انسان|موظف|احد|صاحب|ها|ه)/,
  /(?:حولني|حولوني|حولنا)/,
];

const WHO: readonly RegExp[] = [
  /\bwho\s+(?:are\s+you|is\s+(?:this|calling|speaking)|am\s+i\s+(?:talking|speaking)\s+to)\b/,
  /\bare\s+you\s+(?:a\s+|an\s+)?(?:robot|machine|computer|bot|ai|real|human|person|recording)\b/,
  /\bwhat\s+is\s+this\s+(?:about|regarding)\b/,
  /\bwhy\s+are\s+you\s+calling\b/,
  /\bwer\s+(?:sind\s+sie|ist\s+da|spricht\s+da|ruft\s+(?:da\s+)?an)\b/,
  /\bsind\s+sie\s+(?:ein\s+|eine\s+)?(?:roboter|mensch|computer|maschine|ki|bot|echt)\b/,
  /\bworum\s+geht\s+es\b/,
  /\bwarum\s+rufen\s+sie\s+an\b/,
  /من\s+(?:انت|معي|المتصل|يتحدث)/,
  /هل\s+(?:انت|انتم)\s+(?:روبوت|اله|انسان|حقيقي|كمبيوتر)/,
  /ما\s+(?:سبب|موضوع)\s+(?:الاتصال|المكالمه)/,
  /لماذا\s+(?:تتصل|تتصلون)/,
];

export const isPersonRequest = (text: string): boolean => {
  const n = fold(normalise(text));
  return any(PERSON, n);
};

export const isWhoAreYou = (text: string): boolean => {
  const n = fold(normalise(text));
  return any(WHO, n);
};

/* ------------------------- questions, requests, personal data ------------------------- */

const QUESTION_START =
  /^(?:(?:who|what|when|where|why|how|which|can|could|would|will|is|are|do|does|did|may|wer|was|wann|wo|warum|wieso|weshalb|wie|welche[nrsm]?|konnen|konnten|wurden|ist|sind|haben|hat|darf)\b|(?:من|ما|ماذا|متي|اين|لماذا|كيف|هل|اي)(?:\s|$))/;

/** The utterance is a question or a request directed at JARVIS. */
export function isQuestion(text: string): boolean {
  const raw = text.trim();
  if (/[?؟]\s*$/.test(raw)) return true;
  return QUESTION_START.test(fold(normalise(raw)));
}

const REQUEST_FORM =
  /\b(?:give|tell|send|say|need|want|what(?:'s| is| are)|could you|can you|would you|i need|we need|geben sie|sagen sie|nennen sie|brauche|brauchen|wie lautet|was ist|konnen sie|konnten sie)\b|(?:اعطني|اعطنا|اخبرني|اخبرنا|نحتاج|احتاج|ما\s+هو|ما\s+هي|هل\s+يمكنك|ارسل)/;

const PERSONAL_DATA =
  /\b(?:address|home address|where (?:does|do) (?:she|he|they) live|date of birth|birth ?date|birthday|age|credit card|card (?:number|details)|bank|iban|account number|password|pin|social security|insurance number|passport|e-?mail|email address|phone number|mobile number|salary|income)\b|\b(?:adresse|anschrift|wo wohnt|geburtsdatum|geburtstag|alter\b|kreditkart|kartennummer|bankverbindung|iban|kontonummer|passwort|pin\b|versicherungsnummer|sozialversicherung|reisepass|e-?mail|telefonnummer|handynummer|gehalt|einkommen)|(?:عنوان|اين\s+(?:تسكن|يسكن|تعيش|يعيش)|تاريخ\s+الميلاد|عمر|بطاقه|رقم\s+البطاقه|بنك|حساب\s+بنكي|رقم\s+الحساب|ايبان|كلمه\s+المرور|الرقم\s+السري|رقم\s+التامين|جواز\s+السفر|بريد|رقم\s+الهاتف|رقم\s+الجوال|راتب|دخل)/;

const ERRAND =
  /\b(?:pay|payment|deposit|transfer (?:the )?money|wire|buy|purchase|order|subscribe|sign (?:up|a contract)|contract|bezahlen|zahlen|zahlung|anzahlung|uberweisen|uberweisung|kaufen|bestellen|abonnieren|vertrag|unterschreiben)\b|(?:ادفع|ادفعوا|دفع|عربون|تحويل\s+(?:المال|مبلغ)|اشتر|شراء|اطلب|اشتراك|عقد|توقيع)/;

/**
 * Personal data or an errand outside the call's purpose is being asked for (JARVIS refuses
 * unless the detail is one the approval lets it share — shareInfoAsked).
 */
export function isOutsidePurposeRequest(text: string): boolean {
  const n = fold(normalise(text));
  const request = REQUEST_FORM.test(n) || isQuestion(text);
  return request && (PERSONAL_DATA.test(n) || ERRAND.test(n));
}

const LABEL_SYNONYMS: readonly [RegExp, RegExp][] = [
  [
    /\bname\b|\bnamen?\b|اسم/,
    /\bname\b|\bnamen?\b|\bwie hei(?:ss|ß)t\b|\bunter welchem namen\b|اسم/,
  ],
  [/birth|geburt|ميلاد/, /birth|geburt|ميلاد/],
  [/phone|telefon|handy|mobile|هاتف|جوال/, /phone|telefon|handy|mobile|callback|ruckruf|هاتف|جوال/],
  [/insurance|versicherung|تامين/, /insurance|versicherung|krankenkasse|تامين/],
  [/e-?mail|بريد/, /e-?mail|بريد/],
  [/address|adresse|anschrift|عنوان/, /address|adresse|anschrift|عنوان/],
];

/** The approved detail the callee asks for, if any (shared verbatim, nothing else). */
export function shareInfoAsked(
  text: string,
  shareInfo: readonly CallShareItem[],
): CallShareItem | null {
  if (shareInfo.length === 0) return null;
  const n = fold(normalise(text));
  if (!REQUEST_FORM.test(n) && !isQuestion(text)) return null;
  for (const item of shareInfo) {
    const label = fold(normalise(item.label));
    const words = label.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2);
    if (words.length > 0 && words.every((w) => n.includes(w))) return item;
    for (const [labelRe, askRe] of LABEL_SYNONYMS)
      if (labelRe.test(label) && askRe.test(n)) return item;
  }
  return null;
}

/* ------------------------------------ yes / no ------------------------------------ */

const YES =
  /\b(?:yes|yeah|yep|yup|sure|ok|okay|of course|certainly|go ahead|that'?s fine|fine|no problem|alright|ja|jawohl|klar|gerne|gern|in ordnung|einverstanden|naturlich|selbstverstandlich|kein problem|passt|okay)\b|(?:نعم|اجل|بالتاكيد|حسنا|موافق|موافقون|طبعا|تفضل|لا\s+مانع|لا\s+باس|ايوه|اكيد)/;
const NO =
  /\b(?:no|nope|nah|don'?t|do not|rather not|not ok|not okay|i'?d rather not|nein|lieber nicht|nicht einverstanden|auf keinen fall|bitte nicht)\b|(?:^|\s)(?:لا|كلا)(?:\s|$)|لا\s+اوافق|لا\s+نوافق|لا\s+اريد|لا\s+نريد|ارفض|نرفض/;
const NO_EXCEPTIONS = /\bno problem\b|\bkein problem\b|لا\s+مانع|لا\s+باس/g;

/** A clear yes, a clear no, or neither (consent: anything unclear counts as no). */
export function yesNo(text: string): 'yes' | 'no' | 'unclear' {
  const n = fold(normalise(text));
  const yes = YES.test(n);
  const no = NO.test(n.replace(NO_EXCEPTIONS, ' '));
  if (yes && !no) return 'yes';
  if (no && !yes) return 'no';
  return 'unclear';
}

/* ------------------------------------- times -------------------------------------- */

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  ein: 1,
  eins: 1,
  zwei: 2,
  drei: 3,
  vier: 4,
  funf: 5,
  sechs: 6,
  sieben: 7,
  acht: 8,
  neun: 9,
  zehn: 10,
  elf: 11,
  zwolf: 12,
  dreizehn: 13,
  vierzehn: 14,
  funfzehn: 15,
  sechzehn: 16,
  siebzehn: 17,
  achtzehn: 18,
  neunzehn: 19,
};
const AR_HOURS: Record<string, number> = {
  الواحده: 1,
  الثانيه: 2,
  الثالثه: 3,
  الرابعه: 4,
  الخامسه: 5,
  السادسه: 6,
  السابعه: 7,
  الثامنه: 8,
  التاسعه: 9,
  العاشره: 10,
  'الحاديه عشر': 11,
  'الحاديه عشره': 11,
  'الثانيه عشر': 12,
  'الثانيه عشره': 12,
};
const WORD = Object.keys(NUMBER_WORDS)
  .sort((a, b) => b.length - a.length)
  .join('|');
const AR_WORD = Object.keys(AR_HOURS)
  .sort((a, b) => b.length - a.length)
  .join('|');

const PM =
  /\b(?:pm|p\.m\.|in the afternoon|in the evening|nachmittags|abends|am nachmittag)\b|(?:مساء|بعد\s+الظهر|عصرا|ظهرا)/;
// German "am Freitag" / "am 13." is a date, not "a.m.".
const AM =
  /\b(?:am(?!\s+(?:montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag|wochenende|\d))|a\.m\.|in the morning|morgens|vormittags|fruh|am vormittag)\b|(?:صباحا)/;

type Hit = { h: number; m: number; meridiem: 'am' | 'pm' | null; at: number };

const PM_NEXT = new RegExp(`^\\s*(?:${PM.source})`);
const AM_NEXT = new RegExp(`^\\s*(?:${AM.source})`);

/** "… in the afternoon" / "nachmittags" / "مساء" right after the time. */
function meridiemNear(n: string, index: number, length: number): 'am' | 'pm' | null {
  const after = n.slice(index + length, index + length + 24);
  if (PM_NEXT.test(after)) return 'pm';
  if (AM_NEXT.test(after)) return 'am';
  return null;
}

/** Clock times written or spoken in the text, before resolving morning / afternoon. */
function rawTimes(n: string): Hit[] {
  const hits: Hit[] = [];
  const push = (h: number, m: number, at: number, len: number, mer?: 'am' | 'pm' | null) => {
    if (h < 0 || h > 23 || m < 0 || m > 59) return;
    if (hits.some((x) => Math.abs(x.at - at) < 3)) return;
    hits.push({ h, m, at, meridiem: mer ?? meridiemNear(n, at, len) });
  };
  let m: RegExpExecArray | null;
  // 9:30, 9h30, 14.30 (a dotted pair is a date in "am 13.11." / "13.11.2026", not a time)
  const digital = /(?<![\d.:])([01]?\d|2[0-3])\s?([:.h])\s?([0-5]\d)(?![\d])/g;
  while ((m = digital.exec(n))) {
    if (m[2] === '.') {
      const before = n.slice(Math.max(0, m.index - 8), m.index);
      const after = n.slice(m.index + m[0].length);
      if (/^\.\d/.test(after) || /\b(?:am|den|vom|zum|on|the)\s$/.test(before)) continue;
      if (/^\.(?:\s|$)/.test(after) && !/\b(?:um|ab|gegen|at)\s$/.test(before)) continue;
    }
    push(+m[1]!, +m[3]!, m.index, m[0].length);
  }
  // 10 am / 3pm / 10 o'clock / 14 uhr / um 9 / at 9 / الساعه 3
  const hourOnly =
    /(?<![\d:.])([01]?\d|2[0-3])\s*(am(?!\s+(?:montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag|wochenende|\d))|a\.m\.|pm|p\.m\.|o'?clock|uhr(?:\s+([0-5]\d))?)(?![a-z])/g;
  while ((m = hourOnly.exec(n))) {
    const suffix = m[2]!;
    const mer = /^a/.test(suffix) ? 'am' : /^p/.test(suffix) ? 'pm' : null;
    push(+m[1]!, m[3] ? +m[3] : 0, m.index, m[0].length, mer ?? undefined);
  }
  const at =
    /\b(?:at|um|ab|gegen)\s+([01]?\d|2[0-3])(?![\d:.])(?!\s*(?:minutes?|min|minuten|hours?|stunden|tage?|days?|\.))/g;
  while ((m = at.exec(n))) push(+m[1]!, 0, m.index, m[0].length);
  const arDigits = /الساعه\s*([01]?\d|2[0-3])(?:\s*[:.]\s*([0-5]\d))?/g;
  while ((m = arDigits.exec(n))) push(+m[1]!, m[2] ? +m[2] : 0, m.index, m[0].length);
  // half past nine / quarter past ten / quarter to eleven / nine thirty / nine o'clock
  const words = new RegExp(
    `\\b(?:(half|quarter)\\s+(past|to|after)\\s+(${WORD})|(${WORD})\\s+(thirty|fifteen|forty[- ]five|o'?clock))\\b`,
    'g',
  );
  while ((m = words.exec(n))) {
    if (m[1]) {
      const base = NUMBER_WORDS[m[3]!]!;
      const delta = m[1] === 'half' ? 30 : 15;
      if (m[2] === 'to') push(base - 1, 60 - delta, m.index, m[0].length);
      else push(base, delta, m.index, m[0].length);
    } else {
      const base = NUMBER_WORDS[m[4]!]!;
      const mm =
        m[5] === "o'clock" || m[5] === 'oclock'
          ? 0
          : m[5] === 'thirty'
            ? 30
            : m[5] === 'fifteen'
              ? 15
              : 45;
      push(base, mm, m.index, m[0].length);
    }
  }
  // halb zehn (= 9:30), viertel nach neun, viertel vor elf, neun uhr (dreissig), um neun
  const de = new RegExp(
    `\\b(?:(halb)\\s+(${WORD})|viertel\\s+(nach|vor)\\s+(${WORD})|(${WORD})\\s+uhr(?:\\s+(dreissig|funfzehn|funfundvierzig))?|um\\s+(${WORD})(?!\\s+(?:minuten|stunden|tage)))\\b`,
    'g',
  );
  while ((m = de.exec(n))) {
    if (m[1]) push(NUMBER_WORDS[m[2]!]! - 1, 30, m.index, m[0].length);
    else if (m[3]) {
      const base = NUMBER_WORDS[m[4]!]!;
      if (m[3] === 'nach') push(base, 15, m.index, m[0].length);
      else push(base - 1, 45, m.index, m[0].length);
    } else if (m[5]) {
      const extra = m[6] === 'dreissig' ? 30 : m[6] === 'funfzehn' ? 15 : m[6] ? 45 : 0;
      push(NUMBER_WORDS[m[5]!]!, extra, m.index, m[0].length);
    } else if (m[7]) push(NUMBER_WORDS[m[7]!]!, 0, m.index, m[0].length);
  }
  // الساعه الثانيه والنصف / الساعه العاشره والربع / الساعه الحاديه عشره الا ربعا
  const ar = new RegExp(
    `(?:الساعه\\s+)?(${AR_WORD})(?:\\s+(والنصف|والربع|الا\\s+ربعا|الا\\s+ربع))?`,
    'g',
  );
  while ((m = ar.exec(n))) {
    // A bare ordinal ("الثانيه") is a time only after "الساعه" or with a fraction.
    if (!/^الساعه/.test(m[0]) && !m[2]) continue;
    const base = AR_HOURS[m[1]!]!;
    if (!m[2]) push(base, 0, m.index, m[0].length);
    else if (m[2] === 'والنصف') push(base, 30, m.index, m[0].length);
    else if (m[2] === 'والربع') push(base, 15, m.index, m[0].length);
    else push(base - 1, 45, m.index, m[0].length);
  }
  return hits.sort((a, b) => a.at - b.at);
}

const hhmm = (h: number, m: number) =>
  `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

/**
 * The times of day the callee offered ("HH:MM", sorted, unique), within `window` when one was
 * approved. An hour without am/pm is read in the window when it fits there, else as business
 * hours (1–7 → afternoon).
 */
export function extractTimes(
  text: string,
  window: { start: string; end: string } | null = null,
): string[] {
  const n = fold(normalise(text));
  const out = new Set<string>();
  for (const hit of rawTimes(n)) {
    const candidates: number[] = [];
    if (hit.meridiem === 'pm') candidates.push(hit.h < 12 ? hit.h + 12 : hit.h);
    else if (hit.meridiem === 'am') candidates.push(hit.h === 12 ? 0 : hit.h);
    else if (hit.h >= 13) candidates.push(hit.h);
    else {
      const both = [hit.h, hit.h + 12].filter((h) => h <= 23);
      const inWindow = window ? both.filter((h) => within(hhmm(h, hit.m), window)) : [];
      candidates.push(inWindow[0] ?? (hit.h >= 1 && hit.h <= 7 ? hit.h + 12 : hit.h));
    }
    for (const h of candidates) {
      const t = hhmm(h, hit.m);
      if (!window || within(t, window)) out.add(t);
    }
  }
  return [...out].sort();
}

export const within = (t: string, w: { start: string; end: string }) => t >= w.start && t <= w.end;

const NEGATIVE =
  /\b(?:no(?:thing)?\s+(?:free|available|open)|nothing(?:'s| is)?\s+(?:free|available)|fully booked|booked up|no appointments?|we'?re closed|we are closed|not available|nichts\s+(?:mehr\s+)?frei|ausgebucht|keine?\s+(?:freien?\s+)?termine?|kein\s+termin|geschlossen|leider\s+nicht)\b|(?:لا\s+يوجد|لا\s+توجد|ليس\s+لدينا|محجوز\s+بالكامل|مغلق|مغلقون|لا\s+مواعيد)/;

/** The callee said there is nothing free (an answer, too). */
export function isNegative(text: string): boolean {
  const n = fold(normalise(text));
  return NEGATIVE.test(n) || /^(?:no|nein)\b|^(?:لا|كلا)(?:\s|$|[،,.!])/.test(n);
}

/** A booking reference the callee gave ("reference 4711", "Buchungsnummer AB12", "رقم الحجز 77"). */
export function referenceIn(text: string): string | null {
  const n = fold(normalise(text));
  const m =
    /\b(?:reference|booking number|confirmation number|ref|buchungsnummer|referenz|vorgangsnummer|terminnummer)\b\s*(?:is|ist|lautet|:|#)?\s*([a-z0-9-]*\d[a-z0-9-]*)\b/i.exec(
      n,
    ) ?? /(?:رقم\s+(?:الحجز|المرجع|التاكيد))\s*(?:هو|:)?\s*([a-z0-9-]*\d[a-z0-9-]*)/i.exec(n);
  return m ? m[1]!.toUpperCase() : null;
}

/** The call language of a text, for logging only (the call's language is approved). */
export const isArabic = (text: string) => /[؀-ۿ]/.test(text);

export type CallLanguage = Locale;
