'use client';

import { useI18n } from '@/i18n/I18nProvider';
import { cx } from '@/lib/cx';

/** Integer micro-dollars (the API's money unit) as localized USD with tabular numerals. */
export function Money({ microUsd, className }: { microUsd: number; className?: string }) {
  const { f } = useI18n();
  return (
    <span className={cx('tabular', className)} dir="ltr">
      {f.currency(microUsd)}
    </span>
  );
}
