'use client';

import { useRouter } from 'next/navigation';
import { useOptimistic, useTransition, type ReactNode } from 'react';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { LANGUAGE_NAMES } from '@/i18n/config';
import { I18nScope, useI18n } from '@/i18n/I18nProvider';
import { writeCookie } from '@/lib/preferences';
import {
  ADMIN_LOCALE_COOKIE,
  ADMIN_LOCALES,
  adminDir,
  resolveAdminLocale,
  type AdminLocale,
  type AdminMessages,
} from './locale';
import styles from './admin.module.css';

/**
 * The admin page's language island: its own i18n scope (German or Arabic, from the server) and
 * an element with that `lang` and `dir`, so the whole content area — copy, numbers, dates,
 * mirroring — follows the admin language while the shell keeps the profile's. The element is a
 * `data-locale-scope` island, so the phone top bar names the page in its language too.
 */
export function AdminScope({
  locale,
  messages,
  children,
}: {
  locale: AdminLocale;
  messages: AdminMessages;
  children: ReactNode;
}) {
  return (
    <I18nScope locale={locale} messages={messages}>
      <div lang={locale} dir={adminDir(locale)} className={styles.scope} data-locale-scope="">
        {children}
      </div>
    </I18nScope>
  );
}

/**
 * Deutsch | العربية, each in its own language. The choice is a cookie for this browser (the
 * profile's language is untouched); the server components re-render in the new language, so
 * the page title follows too.
 */
export function AdminLanguageSwitch() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const current = resolveAdminLocale(locale);
  const [, startTransition] = useTransition();
  // Shows the new choice at once while the page re-renders in that language.
  const [shown, setShown] = useOptimistic(current);
  const choose = (next: AdminLocale) => {
    if (next === current) return;
    writeCookie(ADMIN_LOCALE_COOKIE, next);
    startTransition(() => {
      setShown(next);
      router.refresh();
    });
  };
  return (
    <SegmentedControl
      legend={t('admin.language.label')}
      name="admin-language"
      size="sm"
      value={shown}
      onChange={choose}
      options={ADMIN_LOCALES.map((l) => ({
        value: l,
        label: (
          <span lang={l} dir={adminDir(l)} className={styles.languageName}>
            {LANGUAGE_NAMES[l]}
          </span>
        ),
      }))}
    />
  );
}
