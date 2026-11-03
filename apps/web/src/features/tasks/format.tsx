'use client';

import { useMemo } from 'react';
import { useI18n } from '@/i18n/I18nProvider';
import { cx } from '@/lib/cx';

/**
 * Exact timestamps for the evidence trail: date + time with seconds in the account's time zone
 * (e.g. "3 Nov 2026, 14:05:32"); `timeOnly` drops the date for same-day timelines.
 */
export function useExactTimeFormat() {
  const { f } = useI18n();
  return useMemo(() => {
    const full = new Intl.DateTimeFormat(f.intlLocale, {
      dateStyle: 'medium',
      timeStyle: 'medium',
      timeZone: f.timeZone,
    });
    const time = new Intl.DateTimeFormat(f.intlLocale, {
      timeStyle: 'medium',
      timeZone: f.timeZone,
    });
    const day = new Intl.DateTimeFormat('en-CA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      timeZone: f.timeZone,
    });
    return {
      full: (d: Date) => full.format(d),
      time: (d: Date) => time.format(d),
      /** Calendar day key in the account's time zone (for grouping). */
      dayKey: (d: Date) => day.format(d),
    };
  }, [f.intlLocale, f.timeZone]);
}

export function ExactTime({
  value,
  timeOnly = false,
  className,
}: {
  value: string;
  timeOnly?: boolean;
  className?: string;
}) {
  const fmt = useExactTimeFormat();
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const full = fmt.full(date);
  return (
    <time dateTime={date.toISOString()} title={full} className={cx('tabular', className)}>
      {timeOnly ? fmt.time(date) : full}
    </time>
  );
}

/** Bytes as "47 KB" / "1.2 MB" in the interface language. */
export function useByteFormat() {
  const { f } = useI18n();
  return useMemo(() => {
    const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte'] as const;
    const fmts = units.map(
      (unit, i) =>
        new Intl.NumberFormat(f.intlLocale, {
          style: 'unit',
          unit,
          unitDisplay: 'short',
          maximumFractionDigits: i < 2 ? 0 : 1,
        }),
    );
    return (bytes: number) => {
      let i = 0;
      let n = bytes;
      while (n >= 1000 && i < units.length - 1) {
        n /= 1000;
        i++;
      }
      return fmts[i]!.format(n);
    };
  }, [f.intlLocale]);
}

/** A duration as "2 s", "1 min 5 s" (Intl unit formatting, interface language). */
export function useDurationFormat() {
  const { f } = useI18n();
  return useMemo(() => {
    const unit = (u: 'millisecond' | 'second' | 'minute' | 'hour') =>
      new Intl.NumberFormat(f.intlLocale, { style: 'unit', unit: u, unitDisplay: 'short' });
    const ms = unit('millisecond');
    const s = unit('second');
    const min = unit('minute');
    const h = unit('hour');
    return (value: number) => {
      if (value < 1000) return ms.format(Math.round(value));
      const totalSeconds = Math.round(value / 1000);
      if (totalSeconds < 60) return s.format(totalSeconds);
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;
      if (minutes < 60)
        return seconds ? `${min.format(minutes)} ${s.format(seconds)}` : min.format(minutes);
      const hours = Math.floor(minutes / 60);
      const rest = minutes % 60;
      return rest ? `${h.format(hours)} ${min.format(rest)}` : h.format(hours);
    };
  }, [f.intlLocale]);
}
