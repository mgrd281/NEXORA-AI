/**
 * Deterministic phrase parsing of the browser + commerce intents (en/de/ar):
 * dates ("2026-11-12", "today", "tomorrow", weekdays, "12 November"), local
 * times ("10:00", "10am", "um 10 Uhr", "الساعة 10"), phone numbers, a name the
 * user gave ("for Alex Example", "ich heiße …", "باسم …"), quantities and
 * product phrases. Nothing is guessed: no match → null, and the intent asks.
 * Only the user's own words are read — never results or pages.
 */

/** Arabic-Indic and Eastern Arabic-Indic digits → ASCII. */
export function asciiDigits(text: string): string {
  return text
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

/** Today's local date (YYYY-MM-DD) in `zone`. */
export function todayIn(zone: string, now: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

const weekdayOf = (date: string): number => {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};

const WEEKDAYS: [RegExp, number][] = [
  [/\bsunday\b|\bsonntags?\b|الأحد|الاحد/i, 0],
  [/\bmonday\b|\bmontags?\b|الاثنين|الإثنين/i, 1],
  [/\btuesday\b|\bdienstags?\b|الثلاثاء/i, 2],
  [/\bwednesday\b|\bmittwochs?\b|الأربعاء|الاربعاء/i, 3],
  [/\bthursday\b|\bdonnerstags?\b|الخميس/i, 4],
  [/\bfriday\b|\bfreitags?\b|الجمعة/i, 5],
  [/\bsaturday\b|\bsamstags?\b|السبت/i, 6],
];

const MONTHS: Record<string, number> = {
  january: 1,
  januar: 1,
  jan: 1,
  february: 2,
  februar: 2,
  feb: 2,
  march: 3,
  märz: 3,
  maerz: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  mai: 5,
  june: 6,
  juni: 6,
  jun: 6,
  july: 7,
  juli: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sept: 9,
  sep: 9,
  october: 10,
  oktober: 10,
  oct: 10,
  okt: 10,
  november: 11,
  nov: 11,
  december: 12,
  dezember: 12,
  dec: 12,
  dez: 12,
  يناير: 1,
  فبراير: 2,
  مارس: 3,
  أبريل: 4,
  ابريل: 4,
  مايو: 5,
  يونيو: 6,
  يوليو: 7,
  أغسطس: 8,
  اغسطس: 8,
  سبتمبر: 9,
  أكتوبر: 10,
  اكتوبر: 10,
  نوفمبر: 11,
  ديسمبر: 12,
};
const MONTH_RE = Object.keys(MONTHS)
  .sort((a, b) => b.length - a.length)
  .join('|');

const valid = (y: number, m: number, d: number): string | null => {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d
    ? t.toISOString().slice(0, 10)
    : null;
};

/** A local date the text names, relative to today in `zone`; null when it names none. */
export function parseDate(raw: string, zone: string, now: Date = new Date()): string | null {
  const text = asciiDigits(raw);
  const today = todayIn(zone, now);
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text);
  if (iso) return valid(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  if (/\bday after tomorrow\b|\bübermorgen\b|بعد\s+غد/i.test(text)) return addDays(today, 2);
  if (/\btomorrow\b|\bmorgen\b|غدا|غداً|غدًا|بكرة/i.test(text)) return addDays(today, 1);
  if (/\btoday\b|\bheute\b|اليوم/i.test(text)) return today;
  const year = Number(today.slice(0, 4));
  // "12 November", "12. November", "November 12", "12 نوفمبر", "12.11." (German)
  const dm =
    new RegExp(`\\b(\\d{1,2})\\.?\\s*(${MONTH_RE})\\b`, 'i').exec(text) ??
    new RegExp(`(\\d{1,2})\\s+(${MONTH_RE})`, 'i').exec(text);
  const md = new RegExp(`\\b(${MONTH_RE})\\s+(\\d{1,2})\\b`, 'i').exec(text);
  const numeric = /\b(\d{1,2})\.(\d{1,2})\.(\d{4})?/.exec(text);
  let date: string | null = null;
  if (dm) date = valid(year, MONTHS[dm[2]!.toLowerCase()]!, Number(dm[1]));
  else if (md) date = valid(year, MONTHS[md[1]!.toLowerCase()]!, Number(md[2]));
  else if (numeric)
    date = valid(numeric[3] ? Number(numeric[3]) : year, Number(numeric[2]), Number(numeric[1]));
  if (date) {
    // A day and month already past this year (and no year written) means next year's.
    if (date < today && !numeric?.[3])
      return valid(year + 1, Number(date.slice(5, 7)), Number(date.slice(8, 10)));
    return date;
  }
  for (const [re, wd] of WEEKDAYS) {
    if (!re.test(text)) continue;
    // The next such day after today ("on Tuesday" said on a Tuesday means next week).
    let d = addDays(today, 1);
    while (weekdayOf(d) !== wd) d = addDays(d, 1);
    return d;
  }
  return null;
}

/** A local time the text names ("10:00", "10am", "3 pm", "um 10 Uhr", "الساعة 10"), as HH:MM. */
export function parseTime(raw: string): string | null {
  const text = asciiDigits(raw).replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ');
  const hhmm = (h: number, m: number) =>
    h >= 0 && h <= 23 && m >= 0 && m <= 59
      ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
      : null;
  const ampm = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)/i.exec(text);
  if (ampm) {
    let h = Number(ampm[1]);
    if (h < 1 || h > 12) return null;
    const pm = /^p/i.test(ampm[3]!);
    if (h === 12) h = pm ? 12 : 0;
    else if (pm) h += 12;
    return hhmm(h, Number(ampm[2] ?? 0));
  }
  const colon = /\b([01]?\d|2[0-3])[:.]([0-5]\d)\b(?!\.\d)/.exec(
    text.replace(/\b\d{1,2}\.\d{1,2}\.\d{2,4}\b/g, ' '),
  );
  if (colon) return hhmm(Number(colon[1]), Number(colon[2]));
  const words =
    /\b(?:at|um|gegen)\s+(\d{1,2})(?:\s*(?:uhr|o'?clock|h))?\b/i.exec(text) ??
    /(?:الساعة|الساعه)\s*(\d{1,2})/.exec(text) ??
    /\b(\d{1,2})\s*uhr\b/i.exec(text);
  if (words) return hhmm(Number(words[1]), 0);
  return null;
}

const PHONE = /(?:\+|00)?\d[\d\s()./-]{6,18}\d/;

/** A phone number the user wrote (as written, normalised spaces), or null. */
export function parsePhone(raw: string): string | null {
  const text = asciiDigits(raw).replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ');
  for (const m of text.matchAll(new RegExp(PHONE, 'g'))) {
    const v = m[0].trim();
    const digits = v.replace(/\D/g, '');
    // Not a time, a date or a year: 7–15 digits, and either international or spaced.
    if (digits.length >= 7 && digits.length <= 15 && !/^\d{1,2}[:.]\d{2}$/.test(v))
      return v.replace(/\s+/g, ' ');
  }
  return null;
}

const EMAIL = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

export function parseEmail(raw: string): string | null {
  return EMAIL.exec(raw)?.[0] ?? null;
}

const NAME_WORD = "[\\p{Lu}][\\p{L}'’-]+";
const NAME_PATTERNS: RegExp[] = [
  new RegExp(`\\b(?:my name is|name is|name:)\\s+(${NAME_WORD}(?:\\s+${NAME_WORD}){0,3})`, 'u'),
  new RegExp(
    `\\b(?:ich heiße|ich heisse|mein name ist|name:)\\s+(${NAME_WORD}(?:\\s+${NAME_WORD}){0,3})`,
    'u',
  ),
  new RegExp(`\\b(?:for|für)\\s+(${NAME_WORD}(?:\\s+${NAME_WORD}){1,3})`, 'u'),
  /(?:باسم|اسمي|الاسم[:：]?)\s+([\p{L}'’-]+(?:\s+[\p{L}'’-]+){0,3})/u,
];

/** Words that end a name: what follows is another detail. */
const NAME_STOP =
  /\s+(?:phone|tel|telephone|mobile|email|e-mail|at|on|tomorrow|today|telefon|handy|am|um|morgen|heute|هاتف|الهاتف|رقم|جوال|البريد|غدا|اليوم|الساعة|يوم)\b[\s\S]*$|\s+(?:هاتف|الهاتف|رقم|جوال|البريد|غدا|اليوم|الساعة|يوم)[\s\S]*$/iu;

/** A name the user gave for the booking ("for Alex Example", "mein Name ist …"), or null. */
export function parseName(raw: string): string | null {
  for (const re of NAME_PATTERNS) {
    const m = re.exec(raw);
    if (!m) continue;
    const name = m[1]!.replace(NAME_STOP, '').trim().replace(/\s+/g, ' ');
    if (name) return name;
  }
  return null;
}

/**
 * The answer to "which details should I give the site?": what is left after the
 * phone number and email address, when it reads as a name (1–4 words, letters).
 */
export function nameFromAnswer(answer: string): string | null {
  const explicit = parseName(answer);
  if (explicit) return explicit;
  const phone = parsePhone(answer);
  const rest = answer
    .replace(phone ?? '\u0000', ' ')
    .replace(new RegExp(EMAIL, 'g'), ' ')
    .replace(/\b(?:phone|tel|telefon|handy|mobile|email|e-mail|mail|name)\b[:\s]*/gi, ' ')
    .replace(/(?:هاتف|رقم|الهاتف|البريد)[:\s]*/g, ' ')
    .replace(/[,;:|()+]/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  if (!rest) return null;
  const words = rest.split(' ');
  return words.length <= 4 && words.every((w) => /^[\p{L}'’.-]+$/u.test(w)) ? rest : null;
}

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
  ein: 1,
  eine: 1,
  einen: 1,
  zwei: 2,
  drei: 3,
  vier: 4,
  fünf: 5,
  sechs: 6,
  sieben: 7,
  acht: 8,
  neun: 9,
  zehn: 10,
  واحد: 1,
  واحدة: 1,
  اثنين: 2,
  اثنان: 2,
  ثلاثة: 3,
  أربعة: 4,
  خمسة: 5,
};

/** A leading quantity of a product phrase ("2 FX-10 earbuds", "2x …", "two …"), and the rest. */
export function splitQuantity(phrase: string): { quantity: number | null; rest: string } {
  const p = asciiDigits(phrase).trim();
  const digit = /^(\d{1,2})\s*(?:x|×|stück|stk\.?|pcs?\.?)?\s+(.+)$/i.exec(p);
  if (digit) return { quantity: Number(digit[1]), rest: digit[2]!.trim() };
  const word = /^(\S+)\s+(.+)$/.exec(p);
  const n = word ? NUMBER_WORDS[word[1]!.toLowerCase()] : undefined;
  // "ein"/"eine"/"one" are also articles: only a quantity when it is not followed by an article-free noun alone.
  if (word && n !== undefined && n > 1) return { quantity: n, rest: word[2]!.trim() };
  return { quantity: null, rest: p };
}

/** A product phrase as a search query: articles and filler dropped, the user's words otherwise kept. */
export function productQuery(phrase: string): string {
  return phrase
    .replace(/^(?:the|a|an|some|die|der|das|den|dem|ein|eine|einen|einem|neue[nrs]?|new)\s+/i, '')
    .replace(/^(?:ال)(?=\S)/, '')
    .replace(/\s+(?:please|bitte|من فضلك)$/i, '')
    .replace(/[.?!؟。]+$/u, '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 200);
}
