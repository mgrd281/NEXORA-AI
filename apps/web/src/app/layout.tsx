import '@jarvis/tokens/tokens.css';
import './globals.css';
import { color } from '@jarvis/tokens';
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { getServerI18n } from '@/i18n/server';
import { fontVariables } from './fonts';
import { Providers } from './Providers';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerI18n();
  return {
    title: { default: t('common.appName'), template: `%s · ${t('common.appName')}` },
    applicationName: t('common.appName'),
    robots: { index: false, follow: false },
    referrer: 'strict-origin-when-cross-origin',
    formatDetection: { telephone: false, email: false, address: false },
  };
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: color.light.canvas },
    { media: '(prefers-color-scheme: dark)', color: color.dark.canvas },
  ],
};

/**
 * Locale (lang/dir) and theme are rendered on the server from the cookies that mirror the
 * profile, so there is no flash of the wrong language, direction or theme.
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const { locale, dir, theme, messages } = await getServerI18n();
  return (
    <html
      lang={locale}
      dir={dir}
      data-theme={theme === 'system' ? undefined : theme}
      className={fontVariables}
    >
      <body>
        <Providers locale={locale} messages={messages}>
          {children}
        </Providers>
      </body>
    </html>
  );
}
