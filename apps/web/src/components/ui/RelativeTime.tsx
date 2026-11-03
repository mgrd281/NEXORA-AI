'use client';

import { useI18n } from '@/i18n/I18nProvider';
import type { DateInput } from '@/i18n/format';
import { useNow } from '@/lib/hooks/useNow';
import { cx } from '@/lib/cx';

/**
 * "5 minutes ago" / "in 2 hours" in the interface language, updated every minute, with the
 * absolute date and time (account time zone) in the title and the machine value in dateTime.
 */
export function RelativeTime({
  value,
  className,
  format,
}: {
  value: DateInput;
  className?: string;
  /** Wrap the relative phrase, e.g. (rel) => t('common.time.updated', { time: rel }). */
  format?: (relative: string) => string;
}) {
  const { f } = useI18n();
  const now = useNow();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const absolute = f.dateTime(date);
  // Before hydration (now === 0) render the absolute time so server and client markup match.
  const relative = now === 0 ? absolute : f.relative(date, now);
  return (
    <time dateTime={date.toISOString()} title={absolute} className={cx('tabular', className)}>
      {format ? format(relative) : relative}
    </time>
  );
}
