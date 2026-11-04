'use client';

import type { Me } from '@jarvis/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Download, Eye, EyeOff } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { ErrorBanner } from '@/components/ui/Banner';
import { Button, ButtonLink, IconButton } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { TextField } from '@/components/ui/Field';
import { useI18n } from '@/i18n/I18nProvider';
import { api, isApiError, type ApiError } from '@/lib/api/client';
import { cx } from '@/lib/cx';
import { DangerZone, SettingRow, SettingsCard } from './controls';
import { SettingsSection } from './SettingsSection';
import { exportFileName } from './exportFile';
import { RetentionSelect } from './RetentionControls';
import styles from './settings.module.css';

export function PrivacySection({ me }: { me: Me }) {
  const { t } = useI18n();
  return (
    <SettingsSection id="privacy" title={t('settings.sections.privacy')}>
      <SettingsCard>
        <SettingRow>
          <div className={styles.actionText}>
            <h3 className={styles.rowTitle}>{t('settings.privacy.retentionTitle')}</h3>
            <p className={styles.rowText}>{t('settings.privacy.retentionDescription')}</p>
          </div>
          <div className={styles.retentionGrid}>
            <RetentionSelect me={me} field="memoryDays" />
            <RetentionSelect me={me} field="taskHistoryDays" />
          </div>
        </SettingRow>
      </SettingsCard>
      <SettingsCard>
        <SettingRow>
          <div className={styles.actionRow}>
            <div className={styles.actionText}>
              <h3 className={styles.rowTitle}>{t('settings.privacy.memoryTitle')}</h3>
              <p className={styles.rowText}>{t('settings.privacy.memoryDescription')}</p>
            </div>
            <ButtonLink
              href="/memory"
              size="sm"
              iconEnd={ArrowRight}
              mirrorIcons
              className={styles.actionButton}
            >
              {t('settings.privacy.memoryLink')}
            </ButtonLink>
          </div>
        </SettingRow>
        <ExportRow />
      </SettingsCard>
      <DeleteAccountCard />
    </SettingsSection>
  );
}

function ExportRow() {
  const { t } = useI18n();
  const [file, setFile] = useState<string | null>(null);
  const exporter = useMutation<Record<string, unknown>, ApiError>({
    mutationFn: () => api.call('exportAccount'),
    onMutate: () => setFile(null),
    onSuccess: (data) => setFile(download(data)),
  });
  return (
    <SettingRow>
      <div className={styles.actionRow}>
        <div className={styles.actionText}>
          <h3 className={styles.rowTitle}>{t('settings.privacy.exportTitle')}</h3>
          <p className={styles.rowText}>{t('settings.privacy.exportDescription')}</p>
        </div>
        <Button
          size="sm"
          icon={Download}
          className={styles.actionButton}
          loading={exporter.isPending}
          onClick={() => exporter.mutate()}
        >
          {t('settings.privacy.exportButton')}
        </Button>
      </div>
      <div role="status" className={cx(styles.note, styles.liveSlot)}>
        {exporter.isPending
          ? t('settings.privacy.exporting')
          : file
            ? t('settings.privacy.exported', { file })
            : null}
      </div>
      {exporter.isError && <ErrorBanner error={exporter.error} onRetry={() => exporter.mutate()} />}
    </SettingRow>
  );
}

/** Saves the export as a JSON file through a temporary object URL. Returns the file name. */
function download(data: Record<string, unknown>): string {
  const name = exportFileName(new Date());
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser a moment to start the download before releasing the blob.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return name;
}

function DeleteAccountCard() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <DangerZone
      title={t('settings.privacy.deleteTitle')}
      description={t('settings.privacy.deleteDescription')}
      action={
        <Button size="sm" variant="danger" onClick={() => setOpen(true)}>
          {t('settings.privacy.deleteButton')}
        </Button>
      }
    >
      {/* Mounted only while open, so the password never outlives the dialog. */}
      {open && <DeleteAccountDialog onClose={() => setOpen(false)} />}
    </DangerZone>
  );
}

const CONFIRM_WORD = 'DELETE';

function DeleteAccountDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const passwordRef = useRef<HTMLInputElement>(null);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const remove = useMutation<void, ApiError>({
    mutationFn: () => api.call('deleteAccount', { body: { password, confirmation: CONFIRM_WORD } }),
    onSuccess: () => {
      queryClient.clear();
      // A full load: nothing of the deleted account may stay in memory.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign('/sign-in');
    },
    onError: (error) => {
      if (isApiError(error, 'FORBIDDEN')) passwordRef.current?.focus();
    },
  });

  const wrongPassword = remove.isError && isApiError(remove.error, 'FORBIDDEN');
  const ready = password.length > 0 && confirmation === CONFIRM_WORD;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready || remove.isPending) return;
    remove.mutate();
  }

  return (
    <Dialog
      open
      onClose={() => {
        if (!remove.isPending) onClose();
      }}
      title={t('settings.privacy.deleteDialog.title')}
      description={t('settings.privacy.deleteDialog.body')}
      initialFocusRef={passwordRef}
      dismissible={!remove.isPending}
      busy={remove.isPending}
      footer={
        <>
          <Button onClick={onClose} disabled={remove.isPending}>
            {t('common.actions.cancel')}
          </Button>
          <Button
            type="submit"
            form="delete-account-form"
            variant="destructive"
            disabled={!ready}
            loading={remove.isPending}
          >
            {remove.isPending
              ? t('settings.privacy.deleteDialog.deleting')
              : t('settings.privacy.deleteDialog.confirm')}
          </Button>
        </>
      }
    >
      <form id="delete-account-form" className={styles.dialogStack} onSubmit={submit} noValidate>
        <p className={styles.dialogText}>{t('settings.privacy.deleteDialog.exportFirst')}</p>
        {remove.isError && !wrongPassword && <ErrorBanner error={remove.error} />}
        <TextField
          ref={passwordRef}
          label={t('settings.privacy.deleteDialog.password')}
          type={showPassword ? 'text' : 'password'}
          autoComplete="current-password"
          dir="ltr"
          value={password}
          error={wrongPassword ? t('settings.privacy.deleteDialog.wrongPassword') : undefined}
          onChange={(e) => setPassword(e.target.value)}
          trailing={
            <IconButton
              size="sm"
              tooltip="none"
              icon={showPassword ? EyeOff : Eye}
              label={
                showPassword
                  ? t('connections.email.form.hidePassword')
                  : t('connections.email.form.showPassword')
              }
              aria-pressed={showPassword}
              onClick={() => setShowPassword((v) => !v)}
            />
          }
        />
        <TextField
          label={t('settings.privacy.deleteDialog.confirmLabel')}
          hint={t('settings.privacy.deleteDialog.confirmHint')}
          value={confirmation}
          dir="ltr"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          onChange={(e) => setConfirmation(e.target.value)}
        />
      </form>
    </Dialog>
  );
}
