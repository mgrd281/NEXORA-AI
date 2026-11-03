import { Locale, RTL_LOCALES, ThemePreference } from '@jarvis/contracts';

export type { Locale };
export type Direction = 'ltr' | 'rtl';
export type SpeechLocale = 'en-US' | 'de-DE' | 'ar-SA';

export const LOCALES: readonly Locale[] = Locale.options;
export const DEFAULT_LOCALE: Locale = 'en';

/** Mirrors me.locale so the server renders <html lang dir> correctly before any data loads. */
export const LOCALE_COOKIE = 'jarvis_locale';
/** Mirrors me.theme; 'system' means no data-theme attribute (the OS decides). */
export const THEME_COOKIE = 'jarvis_theme';
/** Set by the API (httpOnly); the web app only checks for its presence. */
export const SESSION_COOKIE = 'jarvis_session';

export function dirFor(locale: Locale): Direction {
  return RTL_LOCALES.includes(locale) ? 'rtl' : 'ltr';
}

export function parseLocale(value: string | null | undefined): Locale | null {
  const parsed = Locale.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function parseTheme(value: string | null | undefined): ThemePreference {
  const parsed = ThemePreference.safeParse(value);
  return parsed.success ? parsed.data : 'system';
}

/** Picks the best supported locale from an Accept-Language header (used before sign-in). */
export function negotiateLocale(acceptLanguage: string | null | undefined): Locale {
  if (!acceptLanguage) return DEFAULT_LOCALE;
  const ranked = acceptLanguage
    .split(',')
    .map((part) => {
      const [tag = '', ...params] = part.trim().split(';');
      const q = params.find((p) => p.trim().startsWith('q='));
      return { tag: tag.toLowerCase(), q: q ? Number(q.trim().slice(2)) || 0 : 1 };
    })
    .filter((x) => x.tag && x.q > 0)
    .sort((a, b) => b.q - a.q);
  for (const { tag } of ranked) {
    const match = parseLocale(tag.split('-')[0]);
    if (match) return match;
  }
  return DEFAULT_LOCALE;
}

/** BCP-47 tags for Intl. Arabic uses Western digits (consistent with input, ids and hashes). */
export const INTL_LOCALE: Record<Locale, string> = {
  en: 'en-US',
  de: 'de-DE',
  ar: 'ar-u-nu-latn',
};

/** Speech recognition / synthesis language for each interface locale. */
export const SPEECH_LOCALE: Record<Locale, SpeechLocale> = {
  en: 'en-US',
  de: 'de-DE',
  ar: 'ar-SA',
};

/** The contract's request language for a recognition language. */
export function localeFromSpeech(speech: SpeechLocale): Locale {
  return speech === 'de-DE' ? 'de' : speech === 'ar-SA' ? 'ar' : 'en';
}

/** Endonyms — a language is always shown in its own name, in every locale. */
export const LANGUAGE_NAMES: Record<Locale, string> = {
  en: 'English',
  de: 'Deutsch',
  ar: 'العربية',
};
