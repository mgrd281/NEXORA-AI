import { INTL_LOCALE, type Locale } from './config';

export type DateInput = Date | string | number;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function toDate(value: DateInput): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * Locale-bound formatters. Dates and times use the account's time zone (me.timeZone) once it
 * is known, else the browser's. Intl objects are created once per formatter set.
 */
export interface Formatters {
  readonly locale: Locale;
  readonly intlLocale: string;
  readonly timeZone: string | undefined;
  number(value: number, options?: Intl.NumberFormatOptions): string;
  percent(fraction: number): string;
  /** e.g. "3 Nov 2026" */
  date(value: DateInput): string;
  /** e.g. "14:05" / "2:05 PM" */
  time(value: DateInput): string;
  /** e.g. "3 Nov 2026, 14:05" — used for absolute timestamps in titles */
  dateTime(value: DateInput): string;
  /** "now", "5 minutes ago", "in 2 hours", "yesterday" … */
  relative(value: DateInput, now?: number): string;
  /** Integer micro-dollars → localized USD. Sub-cent amounts keep two significant digits. */
  currency(microUsd: number): string;
  list(items: readonly string[], type?: Intl.ListFormatType): string;
}

export function createFormatters(locale: Locale, timeZone?: string): Formatters {
  const tag = INTL_LOCALE[locale];
  const tz = timeZone && isValidTimeZone(timeZone) ? timeZone : undefined;
  const numberFmt = new Intl.NumberFormat(tag);
  const percentFmt = new Intl.NumberFormat(tag, { style: 'percent', maximumFractionDigits: 0 });
  const dateFmt = new Intl.DateTimeFormat(tag, { dateStyle: 'medium', timeZone: tz });
  const timeFmt = new Intl.DateTimeFormat(tag, { timeStyle: 'short', timeZone: tz });
  const dateTimeFmt = new Intl.DateTimeFormat(tag, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: tz,
  });
  const relativeFmt = new Intl.RelativeTimeFormat(tag, { numeric: 'auto' });
  const money = new Intl.NumberFormat(tag, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const smallMoney = new Intl.NumberFormat(tag, {
    style: 'currency',
    currency: 'USD',
    maximumSignificantDigits: 2,
  });
  const listFmts = new Map<Intl.ListFormatType, Intl.ListFormat>();

  return {
    locale,
    intlLocale: tag,
    timeZone: tz,
    number: (value, options) =>
      options ? new Intl.NumberFormat(tag, options).format(value) : numberFmt.format(value),
    percent: (fraction) => percentFmt.format(fraction),
    date: (value) => dateFmt.format(toDate(value)),
    time: (value) => timeFmt.format(toDate(value)),
    dateTime: (value) => dateTimeFmt.format(toDate(value)),
    relative(value, now = Date.now()) {
      const diff = toDate(value).getTime() - now;
      const abs = Math.abs(diff);
      if (abs < 45_000) return relativeFmt.format(0, 'second');
      if (abs < 45 * MINUTE) return relativeFmt.format(Math.round(diff / MINUTE), 'minute');
      if (abs < 24 * HOUR) return relativeFmt.format(Math.round(diff / HOUR), 'hour');
      if (abs < 26 * DAY) return relativeFmt.format(Math.round(diff / DAY), 'day');
      if (abs < 320 * DAY) return relativeFmt.format(Math.round(diff / (30 * DAY)), 'month');
      return relativeFmt.format(Math.round(diff / (365 * DAY)), 'year');
    },
    currency(microUsd) {
      const usd = microUsd / 1_000_000;
      if (usd > 0 && usd < 0.01) return smallMoney.format(usd);
      return money.format(usd);
    },
    list(items, type = 'conjunction') {
      let fmt = listFmts.get(type);
      if (!fmt) {
        fmt = new Intl.ListFormat(tag, { type, style: 'long' });
        listFmts.set(type, fmt);
      }
      return fmt.format(items);
    },
  };
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone });
    return true;
  } catch {
    return false;
  }
}
