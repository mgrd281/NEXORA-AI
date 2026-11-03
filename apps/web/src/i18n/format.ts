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
  /**
   * A duration in milliseconds: "107 ms", "2 s", "1 min 5 s". `prose` (default) reads as
   * words where a locale's abbreviations are unnatural (Arabic: "107 ملّي ثانية"); `compact`
   * is for tables and chips: Arabic then uses the international symbols in an LTR-isolated run.
   */
  duration(ms: number, style?: 'prose' | 'compact'): string;
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
  const list = (items: readonly string[], type: Intl.ListFormatType = 'conjunction') => {
    let fmt = listFmts.get(type);
    if (!fmt) {
      fmt = new Intl.ListFormat(tag, { type, style: 'long' });
      listFmts.set(type, fmt);
    }
    return fmt.format(items);
  };
  const durationFmts = new Map<string, Intl.NumberFormat>();
  const unitFmt = (unit: DurationUnit, display: 'short' | 'long', tagFor = tag) => {
    const key = `${unit}:${display}:${tagFor}`;
    let fmt = durationFmts.get(key);
    if (!fmt) {
      fmt = new Intl.NumberFormat(tagFor, { style: 'unit', unit, unitDisplay: display });
      durationFmts.set(key, fmt);
    }
    return fmt;
  };

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
    duration(ms, style = 'prose') {
      // Arabic short units ("ملي ث", "ث") read as abbreviations nobody writes: words joined
      // with "و" in prose, the international symbols (LTR-isolated) in compact places.
      if (locale === 'ar') {
        if (style === 'compact') {
          const parts = durationParts(ms, (u, n) => unitFmt(u, 'short', 'en-US').format(n));
          return `\u2066${parts.join(' ')}\u2069`;
        }
        const parts = durationParts(ms, (u, n) => unitFmt(u, 'long').format(n));
        return list(parts).replace(/ملي(?=\s*ثانية)/g, 'ملّي');
      }
      return durationParts(ms, (u, n) => unitFmt(u, 'short').format(n)).join(' ');
    },
    list,
  };
}

type DurationUnit = 'millisecond' | 'second' | 'minute' | 'hour';

/** 950 → ["950 ms"], 2_400 → ["2 s"], 65_000 → ["1 min", "5 s"], 3_900_000 → ["1 h", "5 min"]. */
function durationParts(ms: number, unit: (u: DurationUnit, n: number) => string): string[] {
  const value = Math.max(0, ms);
  if (value < 1000) return [unit('millisecond', Math.round(value))];
  const totalSeconds = Math.round(value / 1000);
  if (totalSeconds < 60) return [unit('second', totalSeconds)];
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60)
    return seconds ? [unit('minute', minutes), unit('second', seconds)] : [unit('minute', minutes)];
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? [unit('hour', hours), unit('minute', rest)] : [unit('hour', hours)];
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone });
    return true;
  } catch {
    return false;
  }
}
