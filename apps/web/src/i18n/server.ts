import 'server-only';
import { cookies, headers } from 'next/headers';
import type { ThemePreference } from '@jarvis/contracts';
import {
  dirFor,
  LOCALE_COOKIE,
  negotiateLocale,
  parseLocale,
  parseTheme,
  THEME_COOKIE,
  type Direction,
  type Locale,
} from './config';
import type { Messages } from './catalog';
import { catalogs } from './messages';
import { createTranslator, type TranslateFn } from './translate';

export interface ServerI18n {
  locale: Locale;
  dir: Direction;
  theme: ThemePreference;
  messages: Messages;
  t: TranslateFn;
}

/**
 * Locale and theme for this request: the cookies mirrored from the profile (me.locale /
 * me.theme), else the browser's Accept-Language before the first sign-in.
 */
export async function getServerI18n(): Promise<ServerI18n> {
  const jar = await cookies();
  const cookieLocale = parseLocale(jar.get(LOCALE_COOKIE)?.value);
  const locale = cookieLocale ?? negotiateLocale((await headers()).get('accept-language'));
  const messages = catalogs[locale];
  return {
    locale,
    dir: dirFor(locale),
    theme: parseTheme(jar.get(THEME_COOKIE)?.value),
    messages,
    t: createTranslator(locale, messages),
  };
}
