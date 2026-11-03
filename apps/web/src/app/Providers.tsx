'use client';

import '@/lib/zod-config';
import type { ReactNode } from 'react';
import { ToastProvider } from '@/components/ui/Toast';
import type { Messages } from '@/i18n/catalog';
import type { Locale } from '@/i18n/config';
import { I18nProvider } from '@/i18n/I18nProvider';
import { QueryProvider } from '@/lib/api/QueryProvider';

/** App-wide client providers: data (React Query), i18n for the active locale, toasts. */
export function Providers({
  locale,
  messages,
  children,
}: {
  locale: Locale;
  messages: Messages;
  children: ReactNode;
}) {
  return (
    <QueryProvider>
      <I18nProvider locale={locale} messages={messages}>
        <ToastProvider>{children}</ToastProvider>
      </I18nProvider>
    </QueryProvider>
  );
}
