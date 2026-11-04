/**
 * Deterministic date / time phrases of the integrations intents (en/de/ar):
 * "today", "tomorrow", weekdays, ISO and common written dates, "this week",
 * "next week", "10:00", "3pm", "15 Uhr", "الساعة 10", durations. Local dates
 * in the account's zone; nothing is guessed: no match → null (the intent asks).
 */
import { addDays, localDate, localParts } from '../../../integrations/timezones';

/** Arabic-Indic and Eastern Arabic-Indic digits → ASCII. */
export function asciiDigits(text: string): string {
  return text
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

const WEEKDAYS: [RegExp, number][] = [
  [/\b(sunday|sun)\b|\bsonntags?\b|الأحد|الاحد/i, 0],
  [/\b(monday|mon)\b|\bmontags?\b|الاثنين|الإثنين/i, 1],
  [/\b(tuesday|tue|tues)\b|\bdienstags?\b|الثلاثاء/i, 2],
  [/\b(wednesday|wed)\b|\bmittwochs?\b|الأربعاء|الاربعاء/i, 3],
  [/\b(thursday|thu|thurs)\b|\bdonnerstags?\b|الخميس/i, 4],
  [/\b(friday|fri)\b|\bfreitags?\b|الجمعة/i, 5],
  [/\b(saturday|sat)\b|\bsamstags?\b|\bsonnabends?\b|السبت/i, 6],
];

const MONTHS: Record<string, number> = {
  january: 1,
  jan: 1,
  januar: 1,
  jänner: 1,
  february: 2,
  feb: 2,
  februar: 2,
  march: 3,
  mar: 3,
  märz: 3,
  maerz: 3,
  april: 4,
  apr: 4,
  may: 5,
  mai: 5,
  june: 6,
  jun: 6,
  juni: 6,
  july: 7,
  jul: 7,
  juli: 7,
  august: 8,
  aug: 8,
  september: 9,
  sep: 9,
  sept: 9,
  october: 10,
  oct: 10,
  oktober: 10,
  okt: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
  dezember: 12,
  dez: 12,
};
const MONTH_NAMES = Object.keys(MONTHS)
  .sort((a, b) => b.length - a.length)
  .join('|');

export interface DayWindow {
  /** First local date (YYYY-MM-DD). */
  from: string;
  /** Local date after the last one (exclusive). */
  to: string;
  /** How much of the text it consumed (removed before reading a time). */
  matched: string;
}

const pad = (n: number) => String(n).padStart(2, '0');

function validDate(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCMonth() !== m - 1) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** A written date that is not in the past: this year, else next year. */
function upcoming(today: string, m: number, d: number, y?: number): string | null {
  const year = Number(today.slice(0, 4));
  if (y !== undefined) return validDate(y < 100 ? 2000 + y : y, m, d);
  const date = validDate(year, m, d);
  if (!date) return null;
  return date >= today ? date : validDate(year + 1, m, d);
}

/** The day(s) a request is about, or null. */
export function parseDays(raw: string, tz: string, now: Date = new Date()): DayWindow | null {
  const text = asciiDigits(raw);
  const today = localDate(now, tz);
  const one = (date: string, matched: string): DayWindow => ({
    from: date,
    to: addDays(date, 1),
    matched,
  });
  let m: RegExpExecArray | null;
  if ((m = /\b(day after tomorrow)\b|übermorgen|بعد\s+غد/i.exec(text)))
    return one(addDays(today, 2), m[0]);
  if ((m = /\b(today|tonight)\b|\bheute\b|اليوم|الليلة/i.exec(text))) return one(today, m[0]);
  if ((m = /\btomorrow\b|\bmorgen\b|غدا|غداً|غدًا|بكرة/i.exec(text)))
    return one(addDays(today, 1), m[0]);
  const weekday = localParts(now, tz).weekday;
  const mondayThisWeek = addDays(today, -((weekday + 6) % 7));
  if (
    (m =
      /\bnext\s+week\b|\bnächste[nr]?\s+woche\b|\bkommende[nr]?\s+woche\b|الأسبوع\s+(القادم|المقبل)/i.exec(
        text,
      ))
  )
    return { from: addDays(mondayThisWeek, 7), to: addDays(mondayThisWeek, 14), matched: m[0] };
  if ((m = /\bthis\s+week\b|\bdiese[rn]?\s+woche\b|هذا\s+الأسبوع/i.exec(text)))
    return { from: today, to: addDays(mondayThisWeek, 7), matched: m[0] };
  if ((m = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text))) {
    const d = validDate(+m[1]!, +m[2]!, +m[3]!);
    if (d) return one(d, m[0]);
  }
  // 12.11. / 12.11.2026 (German order)
  if ((m = /\b(\d{1,2})\.(\d{1,2})\.(\d{2,4})?(?!\d)/.exec(text))) {
    const d = upcoming(today, +m[2]!, +m[1]!, m[3] ? +m[3] : undefined);
    if (d) return one(d, m[0]);
  }
  // 12 November / 12. November / November 12
  if (
    (m = new RegExp(`\\b(\\d{1,2})\\.?\\s+(${MONTH_NAMES})\\b(?:\\s+(\\d{4}))?`, 'i').exec(text))
  ) {
    const d = upcoming(today, MONTHS[m[2]!.toLowerCase()]!, +m[1]!, m[3] ? +m[3] : undefined);
    if (d) return one(d, m[0]);
  }
  if (
    (m = new RegExp(
      `\\b(${MONTH_NAMES})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`,
      'i',
    ).exec(text))
  ) {
    const d = upcoming(today, MONTHS[m[1]!.toLowerCase()]!, +m[2]!, m[3] ? +m[3] : undefined);
    if (d) return one(d, m[0]);
  }
  for (const [re, day] of WEEKDAYS) {
    const w = re.exec(text);
    if (!w) continue;
    // The next such day (a week ahead when it is today: "on Tuesday" said on a Tuesday means next week).
    const delta = (day - weekday + 7) % 7 || 7;
    return one(addDays(today, delta), w[0]);
  }
  return null;
}

/** A clock time ("10:00", "9.30", "3pm", "15 Uhr", "الساعة 10"), or null. */
export function parseTime(raw: string): { hour: number; minute: number; matched: string } | null {
  const text = asciiDigits(raw);
  let m: RegExpExecArray | null;
  if ((m = /\b(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*(am|pm|a\.m\.|p\.m\.)/i.exec(text))) {
    let hour = +m[1]! % 12;
    if (/^p/i.test(m[3]!)) hour += 12;
    return { hour, minute: m[2] ? +m[2] : 0, matched: m[0] };
  }
  if ((m = /\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/.exec(text)))
    return { hour: +m[1]!, minute: +m[2]!, matched: m[0] };
  if ((m = /\b([01]?\d|2[0-3])\s*uhr(?:\s*([0-5]\d))?\b/i.exec(text)))
    return { hour: +m[1]!, minute: m[2] ? +m[2] : 0, matched: m[0] };
  if ((m = /الساعة\s*([01]?\d|2[0-3])(?::([0-5]\d))?/.exec(text)))
    return { hour: +m[1]!, minute: m[2] ? +m[2] : 0, matched: m[0] };
  if ((m = /\bat\s+([01]?\d|2[0-3])\b(?!\s*(?:min|minutes|hours?))/i.exec(text)))
    return { hour: +m[1]!, minute: 0, matched: m[0] };
  return null;
}

/** "for 30 minutes", "45 min", "an hour", "1,5 Stunden", "ساعة", "30 دقيقة" → minutes. */
export function parseDuration(raw: string): number | null {
  const text = asciiDigits(raw);
  let m: RegExpExecArray | null;
  if (
    (m = /\b(\d{1,3})\s*(?:min|mins|minutes|minuten|minute)\b|(\d{1,3})\s*(?:دقيقة|دقائق)/i.exec(
      text,
    ))
  )
    return Number(m[1] ?? m[2]);
  if ((m = /\b(\d(?:[.,]5)?)\s*(?:hours?|stunden?|h)\b|(\d)\s*(?:ساعات|ساعة)/i.exec(text)))
    return Math.round(Number(String(m[1] ?? m[2]).replace(',', '.')) * 60);
  if (
    /\b(an|one)\s+hour\b|\beine\s+stunde\b|\bhalf\s+an\s+hour\b|\beine\s+halbe\s+stunde\b|نصف\s+ساعة|\bساعة\b/i.test(
      text,
    )
  )
    return /half|halbe|نصف/i.test(text) ? 30 : 60;
  return null;
}

export const EMAIL_IN_TEXT = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** The email addresses written in the text, in order, unique, lower case. */
export function addressesIn(text: string): string[] {
  return [...new Set([...text.matchAll(EMAIL_IN_TEXT)].map((m) => m[0].toLowerCase()))];
}

export const localDateTimeString = (date: string, hour: number, minute: number) =>
  `${date}T${pad(hour)}:${pad(minute)}`;

/** Adds minutes to a local "YYYY-MM-DDTHH:MM" (wall-clock arithmetic; the tool resolves it in the zone). */
export function addMinutesLocal(local: string, minutes: number): string {
  const [date, time] = local.split('T') as [string, string];
  const [h, m] = time.split(':').map(Number) as [number, number];
  const total = h * 60 + m + minutes;
  const days = Math.floor(total / 1440);
  const rest = ((total % 1440) + 1440) % 1440;
  return localDateTimeString(addDays(date, days), Math.floor(rest / 60), rest % 60);
}
