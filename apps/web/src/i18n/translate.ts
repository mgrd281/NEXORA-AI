import { INTL_LOCALE, type Locale } from './config';
import type { MessageKey, Messages } from './catalog';
import { formatIcu } from './icu';
import type { MessageParams } from './types';

export type TranslateFn = (key: MessageKey, params?: MessageParams) => string;

/** Looks up a dotted key; returns undefined when the path does not end at a string. */
export function lookup(messages: Messages, key: string): string | undefined {
  let node: unknown = messages;
  for (const part of key.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : undefined;
}

/**
 * Creates t(key, params) for one locale. A missing key renders the key itself (and warns in
 * development) so a gap is visible instead of silently blank.
 */
export function createTranslator(locale: Locale, messages: Messages): TranslateFn {
  const tag = INTL_LOCALE[locale];
  const plural = new Intl.PluralRules(tag);
  const numberFmt = new Intl.NumberFormat(tag);
  const ctx = { plural, number: (n: number) => numberFmt.format(n) };
  return (key, params) => {
    const message = lookup(messages, key);
    if (message === undefined) {
      if (process.env.NODE_ENV !== 'production') console.warn(`[i18n] missing ${locale}:${key}`);
      return key;
    }
    if (!params && !message.includes('{')) return message;
    return formatIcu(message, params ?? {}, ctx);
  };
}

/** Translates a key built at runtime (e.g. from an API enum). Falls back when absent. */
export function translateDynamic(
  t: TranslateFn,
  messages: Messages,
  key: string,
  fallback: MessageKey,
  params?: MessageParams,
): string {
  return lookup(messages, key) !== undefined ? t(key as MessageKey, params) : t(fallback, params);
}
