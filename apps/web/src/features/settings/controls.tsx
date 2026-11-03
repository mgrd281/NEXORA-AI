'use client';

import type { Me, UpdateMeRequest } from '@jarvis/contracts';
import { Check, CircleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { Icon } from '@/components/ui/Icon';
import { Spinner } from '@/components/ui/Spinner';
import { Switch } from '@/components/ui/Switch';
import { useI18n } from '@/i18n/I18nProvider';
import { describeError } from '@/lib/api/errors';
import { cx } from '@/lib/cx';
import { useDelayedFlag } from '@/lib/hooks/useDelayedFlag';
import { useSaveMe, type SaveState } from './api';
import { applyPatch } from './patch';
import styles from './settings.module.css';

/**
 * Save feedback for one control: "Saving…" (only if it takes a moment), "Saved", or the reason
 * it failed. The status line is a polite live region; a failure is announced assertively.
 */
export function SaveStatus({
  state,
  error,
  className,
}: {
  state: SaveState;
  error: unknown;
  className?: string;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const slow = useDelayedFlag(state === 'saving', 400);
  return (
    <div className={cx(styles.saveStatus, className)}>
      <span role="status" className={styles.saveLive}>
        {slow && (
          <span className={styles.saveText}>
            <Spinner size={16} />
            {t('settings.save.saving')}
          </span>
        )}
        {state === 'saved' && (
          <span className={cx(styles.saveText, styles.saved)}>
            <Icon icon={Check} size={16} />
            {t('settings.save.saved')}
          </span>
        )}
      </span>
      {state === 'error' && (
        <p role="alert" className={styles.saveError}>
          <Icon icon={CircleAlert} size={16} />
          <span>{t('settings.save.failed', { reason: describeError(error, i18n).message })}</span>
        </p>
      )}
    </div>
  );
}

/** A card whose children are rows separated by hairlines. */
export function SettingsCard({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx(styles.card, className)}>{children}</div>;
}

export function SettingRow({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx(styles.row, className)}>{children}</div>;
}

/**
 * A preference switch that saves on change. While the request runs the switch shows the new
 * value (busy); if the server refuses, the cached profile is unchanged, so the switch returns
 * to the saved value and the reason is shown.
 */
export function PreferenceSwitch({
  me,
  label,
  description,
  read,
  write,
}: {
  me: Me;
  label: ReactNode;
  description?: ReactNode;
  read: (me: Me) => boolean;
  write: (value: boolean) => UpdateMeRequest;
}) {
  const saver = useSaveMe();
  const pendingValue = saver.variables ? read(applyPatch(me, saver.variables)) : undefined;
  const checked = pendingValue ?? read(me);
  return (
    <SettingRow>
      <Switch
        checked={checked}
        busy={saver.pending}
        label={label}
        description={description}
        onChange={(next) => {
          // One change at a time: a second click while saving would race the first.
          if (saver.pending) return;
          saver.save(write(next));
        }}
      />
      <SaveStatus state={saver.state} error={saver.error} />
    </SettingRow>
  );
}
