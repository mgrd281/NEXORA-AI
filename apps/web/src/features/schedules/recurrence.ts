/**
 * Recurrences phrased on the client, from their fields (the server sends no prose for them):
 * "Every Monday and Wednesday at 9:00 AM", "Monatlich am 1. und letzten Tag um 08:00",
 * "كل أسبوعين يوم الاثنين الساعة 9:00 ص". Weekday names, lists and times come from Intl in the
 * interface language; the sentence frames come from the schedules catalog. Pure — unit-tested.
 */
import type { Recurrence, Weekday } from '@jarvis/contracts';
import { Weekday as WeekdayEnum } from '@jarvis/contracts';
import type { MessageKey } from '@/i18n/catalog';
import type { Formatters } from '@/i18n/format';
import type { TranslateFn } from '@/i18n/translate';

export const WEEKDAYS: readonly Weekday[] = WeekdayEnum.options;
const WORKDAYS: readonly Weekday[] = ['MO', 'TU', 'WE', 'TH', 'FR'];

/** Weekday names in a locale ('long' for sentences, 'short' for toggles), Monday first. */
export function weekdayNames(
  intlLocale: string,
  width: 'long' | 'short' | 'narrow' = 'long',
): Record<Weekday, string> {
  const fmt = new Intl.DateTimeFormat(intlLocale, { weekday: width, timeZone: 'UTC' });
  // 2024-01-01 was a Monday.
  return Object.fromEntries(
    WEEKDAYS.map((day, i) => [day, fmt.format(new Date(Date.UTC(2024, 0, 1 + i)))]),
  ) as Record<Weekday, string>;
}

/** "HH:MM" → the time of day as the locale writes it ("9:00 AM", "09:00", "9:00 ص"). */
export function formatLocalTime(time: string, intlLocale: string): string {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) return time;
  return new Intl.DateTimeFormat(intlLocale, {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(2024, 0, 1, Number(match[1]), Number(match[2]))));
}

/** An instant as a wall-clock date and time in `timeZone` ("Mon, Nov 9, 9:00 AM"). */
export function formatInZone(
  iso: string,
  timeZone: string,
  intlLocale: string,
  { weekday = true }: { weekday?: boolean } = {},
): string {
  const options: Intl.DateTimeFormatOptions = {
    ...(weekday ? { weekday: 'short' } : {}),
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  };
  try {
    return new Intl.DateTimeFormat(intlLocale, { ...options, timeZone }).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat(intlLocale, options).format(new Date(iso));
  }
}

/** A calendar date "YYYY-MM-DD" as the locale writes it. */
function formatDate(date: string, intlLocale: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return date;
  return new Intl.DateTimeFormat(intlLocale, { dateStyle: 'medium', timeZone: 'UTC' }).format(d);
}

export function sortWeekdays(days: readonly Weekday[]): Weekday[] {
  return [...new Set(days)].sort((a, b) => WEEKDAYS.indexOf(a) - WEEKDAYS.indexOf(b));
}

/** Days of the month in calendar order, the last day (−1) at the end. */
export function sortMonthDays(days: readonly number[]): number[] {
  return [...new Set(days)].sort((a, b) => (a === -1 ? 1 : b === -1 ? -1 : a - b));
}

const ORDINAL_KEYS = new Set(['one', 'two', 'few', 'other']);

function monthDayLabel(day: number, t: TranslateFn, intlLocale: string): string {
  if (day === -1) return t('schedules.recurrence.lastDay');
  const category = new Intl.PluralRules(intlLocale, { type: 'ordinal' }).select(day);
  const key = ORDINAL_KEYS.has(category) ? category : 'other';
  // The day number is plain text here (no isolation needed: digits inside a word).
  return t(`schedules.recurrence.ordinal.${key}` as MessageKey, { n: String(day) }).replace(
    /[⁨⁩]/g,
    '',
  );
}

/** The recurrence as one sentence in the interface language. */
export function describeRecurrence(
  r: Pick<
    Recurrence,
    'frequency' | 'interval' | 'byWeekday' | 'byMonthDay' | 'time' | 'until' | 'count'
  >,
  { t, f }: { t: TranslateFn; f: Pick<Formatters, 'list' | 'intlLocale'> },
): string {
  const count = r.interval ?? 1;
  const time = formatLocalTime(r.time, f.intlLocale);
  let phrase: string;
  if (r.frequency === 'weekly') {
    const days = sortWeekdays(r.byWeekday ?? []);
    if (days.length === 7) {
      phrase =
        count === 1
          ? t('schedules.recurrence.daily', { count: 1, time })
          : t('schedules.recurrence.weekly', {
              count,
              days: f.list(days.map((d) => weekdayNames(f.intlLocale)[d])),
              time,
            });
    } else if (days.length === WORKDAYS.length && WORKDAYS.every((d) => days.includes(d))) {
      phrase = t('schedules.recurrence.workdays', { count, time });
    } else {
      const names = weekdayNames(f.intlLocale);
      phrase = t('schedules.recurrence.weekly', {
        count,
        days: f.list(days.map((d) => names[d])),
        time,
      });
    }
  } else if (r.frequency === 'monthly') {
    const days = sortMonthDays(r.byMonthDay ?? []).map((d) => monthDayLabel(d, t, f.intlLocale));
    phrase = t('schedules.recurrence.monthly', { count, days: f.list(days), time });
  } else {
    phrase = t('schedules.recurrence.daily', { count, time });
  }
  if (r.until) {
    return t('schedules.recurrence.until', { phrase, date: formatDate(r.until, f.intlLocale) });
  }
  if (r.count) return t('schedules.recurrence.count', { phrase, count: r.count });
  return phrase;
}

/** A sensible first recurrence for a new schedule: every day at 09:00. */
export function defaultRecurrence(timeZone: string): Recurrence {
  return { frequency: 'daily', interval: 1, time: '09:00', timeZone };
}

/**
 * Changing the frequency keeps what still applies and fills in what the new one needs, so the
 * recurrence stays valid for the contract (weekly needs weekdays, monthly needs days).
 */
export function withFrequency(
  r: Recurrence,
  frequency: Recurrence['frequency'],
  today: Date = new Date(),
): Recurrence {
  const base: Recurrence = {
    frequency,
    interval: r.interval,
    time: r.time,
    timeZone: r.timeZone,
    ...(r.until ? { until: r.until } : {}),
    ...(r.count ? { count: r.count } : {}),
  };
  if (frequency === 'weekly') {
    const todayCode = WEEKDAYS[(today.getUTCDay() + 6) % 7]!;
    return { ...base, byWeekday: r.byWeekday?.length ? r.byWeekday : [todayCode] };
  }
  if (frequency === 'monthly') {
    return { ...base, byMonthDay: r.byMonthDay?.length ? r.byMonthDay : [today.getUTCDate()] };
  }
  return base;
}
