'use client';

import type { Me } from '@jarvis/contracts';
import { useId, useRef, useState, type FormEvent } from 'react';
import { TextField } from '@/components/ui/Field';
import { useI18n } from '@/i18n/I18nProvider';
import { useSaveMe } from './api';
import { SaveStatus, SettingRow, SettingsCard } from './controls';
import { SettingsSection } from './SettingsSection';
import styles from './settings.module.css';

const MAX_NAME = 80;

export function ProfileSection({ me }: { me: Me }) {
  const { t, f } = useI18n();
  const saver = useSaveMe();
  // The draft follows the saved name until the person starts typing.
  const [draft, setDraft] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const value = draft ?? me.displayName;
  const trimmed = value.trim();
  const invalid = trimmed.length === 0;
  const dirty = trimmed !== me.displayName;
  const emailLabelId = useId();

  const inputRef = useRef<HTMLInputElement>(null);

  // Saves when the field is left or Enter is pressed, like every other setting on the page.
  function commit() {
    if (draft === null) return;
    setTouched(true);
    if (invalid) return;
    if (!dirty) {
      setDraft(null);
      return;
    }
    if (saver.pending) return;
    const sent = value;
    saver.save(
      { displayName: trimmed },
      // Keep anything typed while the save was running.
      { onSuccess: () => setDraft((d) => (d === sent ? null : d)) },
    );
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (invalid) {
      setTouched(true);
      inputRef.current?.focus();
      return;
    }
    commit();
  }

  return (
    <SettingsSection id="profile" title={t('settings.sections.profile')}>
      <SettingsCard>
        <SettingRow>
          <form onSubmit={submit} noValidate>
            <TextField
              ref={inputRef}
              label={t('settings.profile.displayName')}
              hint={t('settings.profile.displayNameHint')}
              error={touched && invalid ? t('settings.profile.displayNameRequired') : undefined}
              value={value}
              maxLength={MAX_NAME}
              autoComplete="name"
              enterKeyHint="done"
              // An empty field follows the interface; a typed name takes its own direction.
              dir={value ? 'auto' : undefined}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && draft !== null) {
                  e.preventDefault();
                  setDraft(null);
                  setTouched(false);
                }
              }}
            />
          </form>
          <SaveStatus state={saver.state} error={saver.error} />
        </SettingRow>
        <SettingRow>
          <div className={styles.readOnly} role="group" aria-labelledby={emailLabelId}>
            <span id={emailLabelId} className={styles.readOnlyLabel}>
              {t('settings.profile.email')}
            </span>
            <span className={styles.readOnlyValue}>
              <span className="ltr">{me.email}</span>
            </span>
            <span className={styles.note}>{t('settings.profile.emailHint')}</span>
          </div>
          <p className={styles.note}>
            {t('settings.profile.memberSince', { date: f.date(me.createdAt) })}
          </p>
        </SettingRow>
      </SettingsCard>
    </SettingsSection>
  );
}
