'use client';

import type { Locale, ThemePreference } from '@jarvis/contracts';
import { useRouter } from 'next/navigation';
import { useCallback } from 'react';
import { LOCALE_COOKIE, parseTheme, THEME_COOKIE } from '@/i18n/config';
import { useI18n } from '@/i18n/I18nProvider';

const ONE_YEAR = 60 * 60 * 24 * 365;

export function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.split('; ').find((part) => part.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

/** Non-sensitive display preference cookies (read by the root layout on the server). */
export function writeCookie(name: string, value: string): void {
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${ONE_YEAR}; SameSite=Lax${secure}`;
}

/** Applies a theme immediately: explicit light/dark set data-theme; system removes it. */
export function applyTheme(theme: ThemePreference): void {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
}

/**
 * Mirrors the profile's locale and theme into the cookies the server renders from. The theme
 * applies at once; a locale change refreshes the server components (new lang/dir and catalog).
 * Call it after PATCH /v1/me changes either, and on sign-in.
 */
export function useApplyAppearance(): (next: { locale?: Locale; theme?: ThemePreference }) => void {
  const router = useRouter();
  const { locale: currentLocale } = useI18n();
  return useCallback(
    (next) => {
      if (next.theme) {
        const stored = readCookie(THEME_COOKIE);
        if (stored === null || parseTheme(stored) !== next.theme)
          writeCookie(THEME_COOKIE, next.theme);
        applyTheme(next.theme);
      }
      if (next.locale && readCookie(LOCALE_COOKIE) !== next.locale) {
        writeCookie(LOCALE_COOKIE, next.locale);
      }
      // Re-render server components in the new language, once per target locale (so a browser
      // that refuses the cookie cannot loop).
      if (next.locale && next.locale !== currentLocale && refreshedFor !== next.locale) {
        refreshedFor = next.locale;
        router.refresh();
      }
    },
    [router, currentLocale],
  );
}

let refreshedFor: Locale | null = null;
