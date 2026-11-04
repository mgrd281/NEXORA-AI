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
   * A duration in milliseconds. `prose` (default) uses the locale's own units ("1 Min. 5 Sek.")
   * and reads as words where a locale's abbreviations are unnatural (Arabic: "107 ملّي ثانية").
   * `compact` is for tables and chips (latencies): the international symbols in every locale,
   * one decimal below 10 s — "412 ms", "1,9 s", "18 s", "1 min 5 s", "1 h 5 min" — numbers in
   * the locale's notation; in Arabic the run is LTR-isolated.
   */
  duration(ms: number, style?: 'prose' | 'compact'): string;
  list(items: readonly string[], type?: Intl.ListFormatType): string;
}

export function createFormatters(locale: Locale, timeZone?: string): Formatters {
  const tag = INTL_LOCALE[locale];
  const tz = timeZone && isValidTimeZone(timeZone) ? timeZone : undefined;
  const numberFmt = new Intl.NumberFormat(tag);
  const decimalFmt = new Intl.NumberFormat(tag, { maximumFractionDigits: 1 });
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
  const unitFmt = (unit: DurationUnit, display: 'short' | 'long') => {
    const key = `${unit}:${display}`;
    let fmt = durationFmts.get(key);
    if (!fmt) {
      fmt = new Intl.NumberFormat(tag, { style: 'unit', unit, unitDisplay: display });
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
      if (style === 'compact') {
        const text = compactDuration(ms, (n, decimal) =>
          (decimal ? decimalFmt : numberFmt).format(n),
        );
        return locale === 'ar' ? `\u2066${text}\u2069` : text;
      }
      // Arabic short units ("ملي ث", "ث") read as abbreviations nobody writes: words joined
      // with "و" in prose.
      if (locale === 'ar') {
        const parts = durationParts(ms, (u, n) => unitFmt(u, 'long').format(n));
        return list(parts).replace(/ملي(?=\s*ثانية)/g, 'ملّي');
      }
      return durationParts(ms, (u, n) => unitFmt(u, 'short').format(n)).join(' ');
    },
    list,
  };
}

type DurationUnit = 'millisecond' | 'second' | 'minute' | 'hour';

const SYMBOL: Record<DurationUnit, string> = {
  millisecond: 'ms',
  second: 's',
  minute: 'min',
  hour: 'h',
};

/** 412 → "412 ms", 1_890 → "1.9 s", 18_400 → "18 s", 65_000 → "1 min 5 s" (no-break spaces). */
function compactDuration(ms: number, num: (n: number, decimal?: boolean) => string): string {
  const value = Math.max(0, ms);
  const sym = (u: DurationUnit, n: string) => `${n}\u00a0${SYMBOL[u]}`;
  if (value < 999.5) return sym('millisecond', num(Math.round(value)));
  // One decimal while it still says something (1.9 s, not 2 s); 9.96 s rounds up to 10 s.
  if (value < 9_950) return sym('second', num(Math.round(value / 100) / 10, true));
  return durationParts(value, (u, n) => sym(u, num(n))).join(' ');
}

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
