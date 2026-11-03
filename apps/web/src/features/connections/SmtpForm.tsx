'use client';

import type { Connection, CreateSmtpConnectionRequest } from '@jarvis/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Eye, EyeOff } from 'lucide-react';
import { useId, useRef, useState, type FormEvent } from 'react';
import { Banner, ErrorBanner } from '@/components/ui/Banner';
import { Button, IconButton } from '@/components/ui/Button';
import { Select, TextField } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { UserText } from '@/components/ui/UserText';
import { useI18n } from '@/i18n/I18nProvider';
import { api, isApiError, type ApiError } from '@/lib/api/client';
import { storeConnection } from './api';
import {
  changeSecurity,
  initialDraft,
  validateDraft,
  type SmtpDraft,
  type SmtpField,
  type SmtpSecurity,
} from './smtp';
import styles from './connections.module.css';

/**
 * The SMTP connection form. "Verify and connect" sends the settings to the API, which signs in
 * to the mail server before saving anything; a refusal shows the server's own (safe) reason.
 * The password lives only in this component's state and is dropped when it unmounts.
 */
export function SmtpForm({
  account,
  onConnected,
  onCancel,
}: {
  account: { email: string; displayName: string };
  onConnected: (connection: Connection) => void;
  onCancel?: () => void;
}) {
  const { t } = useI18n();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const titleId = useId();
  const [state, setDraft] = useState<SmtpDraft>(() =>
    initialDraft({ email: '', displayName: '' }, t('connections.email.title')),
  );
  // The sender defaults to the account until the person edits it (the profile may load after
  // this form first renders).
  const [edited, setEdited] = useState({ fromAddress: false, fromName: false });
  const draft: SmtpDraft = {
    ...state,
    fromAddress: edited.fromAddress ? state.fromAddress : account.email,
    fromName: edited.fromName ? state.fromName : account.displayName,
  };
  const [invalid, setInvalid] = useState<SmtpField[]>([]);
  const [showPassword, setShowPassword] = useState(false);
  const labelRef = useRef<HTMLInputElement>(null);
  const hostRef = useRef<HTMLInputElement>(null);
  const portRef = useRef<HTMLInputElement>(null);
  const fromRef = useRef<HTMLInputElement>(null);

  const connect = useMutation<Connection, ApiError, CreateSmtpConnectionRequest>({
    mutationFn: (body) => api.call('connectSmtp', { body }),
    onSuccess: (saved) => {
      storeConnection(queryClient, saved);
      toast({
        message: t('connections.email.connected', { address: saved.accountIdentifier ?? '' }),
      });
      onConnected(saved);
    },
  });

  const set = <K extends keyof SmtpDraft>(key: K, value: SmtpDraft[K]) => {
    if (key === 'fromAddress' || key === 'fromName') setEdited((e) => ({ ...e, [key]: true }));
    setDraft((d) => ({ ...d, [key]: value }));
    if (invalid.length) setInvalid((list) => list.filter((f) => f !== key));
  };

  function submit(e: FormEvent) {
    e.preventDefault();
    if (connect.isPending) return;
    const result = validateDraft(draft);
    if (!result.ok) {
      setInvalid(result.fields);
      const first = (['label', 'host', 'port', 'fromAddress'] as const).find((f) =>
        result.fields.includes(f),
      );
      const target = { label: labelRef, host: hostRef, port: portRef, fromAddress: fromRef };
      if (first) target[first].current?.focus();
      return;
    }
    setInvalid([]);
    connect.mutate(result.body);
  }

  const error = (field: SmtpField) =>
    invalid.includes(field) ? t(`connections.email.form.errors.${field}`) : undefined;
  const verifyFailed = connect.isError && isApiError(connect.error, 'CONNECTION_FAILED');

  return (
    <form className={styles.form} onSubmit={submit} aria-labelledby={titleId} noValidate>
      <div className={styles.formIntro}>
        <h3 id={titleId} className={styles.subTitle}>
          {t('connections.email.form.title')}
        </h3>
        <p className={styles.hint}>{t('connections.email.setupHint')}</p>
      </div>

      <div className={styles.grid}>
        <TextField
          ref={labelRef}
          fieldClassName={styles.span6}
          label={t('connections.email.form.label')}
          hint={t('connections.email.form.labelHint')}
          error={error('label')}
          value={draft.label}
          maxLength={60}
          dir={draft.label ? 'auto' : undefined}
          autoComplete="off"
          required
          onChange={(e) => set('label', e.target.value)}
        />
        <TextField
          ref={hostRef}
          fieldClassName={styles.span4}
          label={t('connections.email.form.host')}
          placeholder={t('connections.email.form.hostPlaceholder')}
          error={error('host')}
          value={draft.host}
          maxLength={253}
          dir="ltr"
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          autoComplete="off"
          required
          onChange={(e) => set('host', e.target.value)}
        />
        <TextField
          ref={portRef}
          fieldClassName={styles.span2}
          label={t('connections.email.form.port')}
          error={error('port')}
          value={draft.port}
          maxLength={5}
          dir="ltr"
          inputMode="numeric"
          autoComplete="off"
          required
          onChange={(e) => set('port', e.target.value.replace(/[^\d]/g, ''))}
        />
        <Select
          fieldClassName={styles.span6}
          label={t('connections.email.form.security')}
          hint={t(`connections.email.form.securityHints.${draft.security}`)}
          value={draft.security}
          onChange={(e) => {
            setDraft((d) => changeSecurity(d, e.target.value as SmtpSecurity));
            setInvalid((list) => list.filter((f) => f !== 'port' && f !== 'host'));
          }}
        >
          {(['tls', 'starttls', 'none'] as const).map((s) => (
            <option key={s} value={s}>
              {t(`connections.email.form.securityOptions.${s}`)}
            </option>
          ))}
        </Select>
        <TextField
          fieldClassName={styles.span3}
          label={t('connections.email.form.username')}
          hint={t('connections.email.form.usernameHint')}
          value={draft.username}
          maxLength={254}
          dir="ltr"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => set('username', e.target.value)}
        />
        <TextField
          fieldClassName={styles.span3}
          label={t('connections.email.form.password')}
          hint={t('connections.email.form.passwordHint')}
          type={showPassword ? 'text' : 'password'}
          value={draft.password}
          maxLength={512}
          dir="ltr"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => set('password', e.target.value)}
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
          ref={fromRef}
          fieldClassName={styles.span3}
          label={t('connections.email.form.fromAddress')}
          error={error('fromAddress')}
          type="email"
          value={draft.fromAddress}
          maxLength={254}
          dir="ltr"
          autoComplete="email"
          required
          onChange={(e) => set('fromAddress', e.target.value)}
        />
        <TextField
          fieldClassName={styles.span3}
          label={t('connections.email.form.fromName')}
          hint={t('connections.email.form.fromNameHint')}
          value={draft.fromName}
          maxLength={80}
          dir={draft.fromName ? 'auto' : undefined}
          autoComplete="off"
          onChange={(e) => set('fromName', e.target.value)}
        />
      </div>

      {verifyFailed ? (
        <Banner tone="danger" live title={t('connections.email.form.failedTitle')}>
          <UserText as="p">{connect.error.message}</UserText>
        </Banner>
      ) : connect.isError ? (
        <ErrorBanner error={connect.error} />
      ) : null}

      <div className={styles.formFooter}>
        <p role="status" className={styles.meta}>
          {connect.isPending
            ? t('connections.email.form.verifying', { host: draft.host.trim() })
            : null}
        </p>
        <div className={styles.actions}>
          {onCancel && (
            <Button variant="ghost" onClick={onCancel} disabled={connect.isPending}>
              {t('connections.email.cancelUpdate')}
            </Button>
          )}
          <Button type="submit" variant="primary" loading={connect.isPending}>
            {t('connections.email.form.submit')}
          </Button>
        </div>
      </div>
    </form>
  );
}
