import 'server-only';
import { cookies } from 'next/headers';
import type { Direction } from '@/i18n/config';
import { catalogs } from '@/i18n/messages';
import { createTranslator, type TranslateFn } from '@/i18n/translate';
import type { Messages } from '@/i18n/catalog';
import {
  ADMIN_LOCALE_COOKIE,
  adminDir,
  pickAdminMessages,
  resolveAdminLocale,
  type AdminLocale,
  type AdminMessages,
} from './locale';

export interface AdminI18n {
  locale: AdminLocale;
  dir: Direction;
  /** Only the admin namespaces (see ADMIN_NAMESPACES), for the client scope. */
  messages: AdminMessages;
  t: TranslateFn;
}

/** The admin page's language for this request (the admin cookie; German by default). */
export async function getAdminI18n(): Promise<AdminI18n> {
  const jar = await cookies();
  const locale = resolveAdminLocale(jar.get(ADMIN_LOCALE_COOKIE)?.value);
  const catalog: Messages = catalogs[locale];
  return {
    locale,
    dir: adminDir(locale),
    messages: pickAdminMessages(catalog),
    t: createTranslator(locale, catalog),
  };
}
