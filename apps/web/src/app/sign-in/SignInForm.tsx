'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Eye, EyeOff } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useId, useRef, useState, type FormEvent } from 'react';
import { Presence } from '@/components/presence/Presence';
import { Banner } from '@/components/ui/Banner';
import { Button, IconButton } from '@/components/ui/Button';
import { TextField } from '@/components/ui/Field';
import { LANGUAGE_NAMES, LOCALE_COOKIE, LOCALES, THEME_COOKIE, type Locale } from '@/i18n/config';
import { useI18n } from '@/i18n/I18nProvider';
import { api, isApiError } from '@/lib/api/client';
import { qk } from '@/lib/api/query-keys';
import { useOnline } from '@/lib/hooks/useOnline';
import { applyTheme, writeCookie } from '@/lib/preferences';
import styles from './sign-in.module.css';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Sign-in: email + password against POST /v1/auth/login (platform web → httpOnly session
 * cookie). On success the profile's language and theme are mirrored into cookies and the app
 * loads at the requested page.
 */
export function SignInForm({ next, sessionEnded }: { next: string; sessionEnded: boolean }) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const queryClient = useQueryClient();
  const online = useOnline();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string }>({});
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const errorId = useId();

  const login = useMutation({
    mutationFn: () =>
      api.call('login', { body: { email: email.trim(), password, platform: 'web' } }),
    onSuccess: ({ user }) => {
      queryClient.setQueryData(qk.me, user);
      writeCookie(LOCALE_COOKIE, user.locale);
      writeCookie(THEME_COOKIE, user.theme);
      applyTheme(user.theme);
      // A full navigation renders the app with the profile's language and direction.
      window.location.assign(next);
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const errors: typeof fieldErrors = {};
    if (!email.trim()) errors.email = t('auth.errors.emailRequired');
    else if (!EMAIL.test(email.trim())) errors.email = t('auth.errors.emailInvalid');
    if (!password) errors.password = t('auth.errors.passwordRequired');
    setFieldErrors(errors);
    if (errors.email) return emailRef.current?.focus();
    if (errors.password) return passwordRef.current?.focus();
    login.mutate();
  };

  const formError = login.isError
    ? isApiError(login.error, 'RATE_LIMITED')
      ? t('auth.errors.rateLimited')
      : isApiError(login.error, 'NETWORK') || !online
        ? t('auth.errors.offline')
        : isApiError(login.error, 'UNAUTHENTICATED') || isApiError(login.error, 'VALIDATION_FAILED')
          ? t('auth.errors.invalidCredentials')
          : t('auth.errors.generic')
    : null;

  const busy = login.isPending || login.isSuccess;

  const switchLanguage = (next: Locale) => {
    if (next === locale) return;
    writeCookie(LOCALE_COOKIE, next);
    router.refresh();
  };

  return (
    <main className={styles.page}>
      <div className={styles.column}>
        {/* The lockup is a mark: ring before wordmark in every direction. */}
        <div className={styles.brand} dir="ltr">
          <Presence state={busy ? 'thinking' : online ? 'idle' : 'offline'} size={40} />
          <span className={styles.wordmark} aria-hidden="true" translate="no">
            {t('common.appName')}
          </span>
        </div>

        <div className={styles.card}>
          <h1 className={styles.title}>{t('auth.title')}</h1>
          {sessionEnded && !login.isError && <Banner tone="info" title={t('auth.sessionEnded')} />}
          {!online && <Banner tone="warning" live title={t('auth.errors.offline')} />}
          <form className={styles.form} onSubmit={submit} noValidate aria-busy={busy || undefined}>
            <TextField
              ref={emailRef}
              label={t('auth.email')}
              type="email"
              name="email"
              autoComplete="username"
              inputMode="email"
              autoCapitalize="none"
              spellCheck={false}
              dir="ltr"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                if (fieldErrors.email) setFieldErrors((f) => ({ ...f, email: undefined }));
              }}
              error={fieldErrors.email}
              aria-describedby={formError ? errorId : undefined}
              aria-invalid={formError ? true : undefined}
              disabled={busy}
              required
            />
            <TextField
              ref={passwordRef}
              label={t('auth.password')}
              type={showPassword ? 'text' : 'password'}
              name="password"
              autoComplete="current-password"
              autoCapitalize="none"
              spellCheck={false}
              dir="ltr"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                if (fieldErrors.password) setFieldErrors((f) => ({ ...f, password: undefined }));
              }}
              error={fieldErrors.password}
              aria-describedby={formError ? errorId : undefined}
              aria-invalid={formError ? true : undefined}
              disabled={busy}
              required
              trailing={
                <IconButton
                  label={showPassword ? t('auth.hidePassword') : t('auth.showPassword')}
                  icon={showPassword ? EyeOff : Eye}
                  size="sm"
                  tooltip="none"
                  aria-pressed={showPassword}
                  onClick={() => setShowPassword((v) => !v)}
                  disabled={busy}
                />
              }
            />
            {formError && (
              <div id={errorId}>
                <Banner tone="danger" live title={formError} />
              </div>
            )}
            <Button type="submit" variant="primary" size="lg" fullWidth loading={busy}>
              {busy ? t('auth.submitting') : t('auth.submit')}
            </Button>
          </form>
        </div>

        <p className={styles.note}>{t('auth.inviteOnly')}</p>

        <div className={styles.languages} role="group" aria-label={t('auth.language')}>
          {LOCALES.map((l) => (
            <button
              key={l}
              type="button"
              lang={l}
              dir="auto"
              className={styles.language}
              aria-pressed={l === locale}
              onClick={() => switchLanguage(l)}
            >
              {LANGUAGE_NAMES[l]}
            </button>
          ))}
        </div>
      </div>
    </main>
  );
}
