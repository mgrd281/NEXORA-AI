import type { Messages } from '@/i18n/catalog';
import { dirFor, type Direction, type Locale } from '@/i18n/config';

/**
 * The admin dashboard (/admin) has a language of its own: German or Arabic, never English,
 * German unless the administrator chose Arabic. It is a per-browser choice (a cookie the server
 * reads, so the first paint is already in that language) and never changes the profile locale:
 * the shell around the page keeps the profile's language and direction.
 */
export const ADMIN_LOCALES = ['de', 'ar'] as const satisfies readonly Locale[];
export type AdminLocale = (typeof ADMIN_LOCALES)[number];
export const DEFAULT_ADMIN_LOCALE: AdminLocale = 'de';

/** Display preference only (not httpOnly): written by the page's language switch. */
export const ADMIN_LOCALE_COOKIE = 'jarvis_admin_locale';

/** The admin language for a cookie value: 'ar' is Arabic, anything else (or none) German. */
export function resolveAdminLocale(value: string | null | undefined): AdminLocale {
  return value === 'ar' ? 'ar' : DEFAULT_ADMIN_LOCALE;
}

export function adminDir(locale: AdminLocale): Direction {
  return dirFor(locale);
}

/**
 * The catalog namespaces the admin page renders: its own copy, the shared words (task states,
 * tool names, actions, time) and error messages. Only these travel to the browser for the
 * admin scope; a key outside them renders as the key, never in another language.
 */
export const ADMIN_NAMESPACES = ['admin', 'common', 'errors'] as const;
export type AdminNamespace = (typeof ADMIN_NAMESPACES)[number];
export type AdminMessages = Pick<Messages, AdminNamespace>;

export function pickAdminMessages(catalog: Messages): AdminMessages {
  return { admin: catalog.admin, common: catalog.common, errors: catalog.errors };
}
