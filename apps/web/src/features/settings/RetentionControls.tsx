'use client';

import type { Me, RetentionPreferences } from '@jarvis/contracts';
import { MEMORY_RETENTION_DAYS, TASK_HISTORY_RETENTION_DAYS } from '@jarvis/contracts';
import { Select } from '@/components/ui/Field';
import type { MessageKey } from '@/i18n/catalog';
import { useI18n } from '@/i18n/I18nProvider';
import type { TranslateFn } from '@/i18n/translate';
import { useSaveMe } from './api';
import { SaveStatus } from './controls';
import { applyPatch } from './patch';

type Field = keyof RetentionPreferences;

const OPTIONS: Record<Field, readonly (number | null)[]> = {
  memoryDays: [null, ...MEMORY_RETENTION_DAYS],
  taskHistoryDays: [null, ...TASK_HISTORY_RETENTION_DAYS],
};

const LABEL: Record<Field, { label: MessageKey; hint: MessageKey }> = {
  memoryDays: {
    label: 'settings.privacy.memoryRetention',
    hint: 'settings.privacy.memoryRetentionHint',
  },
  taskHistoryDays: {
    label: 'settings.privacy.taskRetention',
    hint: 'settings.privacy.taskRetentionHint',
  },
};

/** "30 days", "1 year", "Until I delete them". */
export function retentionPeriod(t: TranslateFn, days: number | null): string {
  switch (days) {
    case null:
      return t('settings.privacy.retention.forever');
    case 30:
      return t('settings.privacy.retention.days30');
    case 90:
      return t('settings.privacy.retention.days90');
    default:
      return t('settings.privacy.retention.days365');
  }
}

/**
 * How long JARVIS keeps memories or finished tasks (preferences.retention). Saves on change;
 * while saving it shows the new value, and returns to the stored one if the server refuses.
 */
export function RetentionSelect({
  me,
  field,
  hint,
  fieldClassName,
}: {
  me: Me;
  field: Field;
  /** The hint for the value shown (default: the general rule). */
  hint?: (days: number | null) => string;
  fieldClassName?: string;
}) {
  const { t } = useI18n();
  const saver = useSaveMe();
  const shown = saver.variables ? applyPatch(me, saver.variables) : me;
  const value = shown.preferences.retention[field];
  return (
    <div>
      <Select
        label={t(LABEL[field].label)}
        hint={hint ? hint(value) : t(LABEL[field].hint)}
        fieldClassName={fieldClassName}
        value={value === null ? 'forever' : String(value)}
        onChange={(e) => {
          if (saver.pending) return;
          const next = e.target.value === 'forever' ? null : Number(e.target.value);
          if (next === me.preferences.retention[field]) return;
          saver.save({ preferences: { retention: { [field]: next } } });
        }}
      >
        {OPTIONS[field].map((days) => (
          <option key={days ?? 'forever'} value={days === null ? 'forever' : String(days)}>
            {retentionPeriod(t, days)}
          </option>
        ))}
      </Select>
      <SaveStatus state={saver.state} error={saver.error} />
    </div>
  );
}
