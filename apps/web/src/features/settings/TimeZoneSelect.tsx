'use client';

import { useMemo, type ReactNode } from 'react';
import { Select } from '@/components/ui/Field';
import { useI18n } from '@/i18n/I18nProvider';
import { useTimeZones } from '@/lib/api/hooks';
import { serverTimeZoneOptions, zoneDisplayName } from './timeZones';

/**
 * A time-zone picker that offers exactly the zones the server accepts (GET /v1/meta/time-zones).
 * While the list loads (or if it fails) only the current zone is offered, with the reason as
 * the hint, so nothing the server would refuse can be chosen.
 */
export function TimeZoneSelect({
  label,
  hint,
  value,
  onChange,
  disabled,
  id,
}: {
  label: ReactNode;
  hint?: ReactNode;
  value: string;
  onChange: (zone: string) => void;
  disabled?: boolean;
  id?: string;
}) {
  const { t } = useI18n();
  const zones = useTimeZones();
  const options = useMemo(
    () =>
      zones.data
        ? serverTimeZoneOptions(zones.data.items, value)
        : [{ value, label: zoneDisplayName(value) }],
    [zones.data, value],
  );
  const status = zones.isPending
    ? t('settings.region.timeZoneLoading')
    : zones.isError
      ? t('settings.region.timeZoneFailed')
      : null;
  return (
    <Select
      id={id}
      label={label}
      hint={status ?? hint}
      value={value}
      disabled={disabled}
      aria-busy={zones.isPending || undefined}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </Select>
  );
}
