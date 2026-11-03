import { INTL_LOCALE, type Locale } from './config';
import type { MessageKey, Messages } from './catalog';
import { formatIcu, FSI, PDI } from './icu';
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

/** Removes bidi isolation marks, e.g. before a translated string becomes request text. */
export function stripIsolates(text: string): string {
  return text.replace(/[\u2066-\u2069]/g, '');
}

/**
 * A translated template with one `{slot}` parameter → its plain text (no bidi marks) and the
 * slot's range in it, so the slot can be selected for the user to type over. The translator
 * isolates the slot value in FSI…PDI, which is how it is found.
 */
export function templateWithSlot(translated: string): { text: string; start: number; end: number } {
  const text = stripIsolates(translated);
  const open = translated.indexOf(FSI);
  const close = translated.indexOf(PDI, open + 1);
  if (open < 0 || close < 0) return { text, start: text.length, end: text.length };
  const start = stripIsolates(translated.slice(0, open)).length;
  const end = start + stripIsolates(translated.slice(open + 1, close)).length;
  return { text, start, end };
}

/**
 * Creates t(key, params) for one locale. A missing key renders the key itself (and warns in
 * development) so a gap is visible instead of silently blank. Interpolated strings are
 * wrapped in FSI…PDI, so a value keeps its own direction inside the sentence: an Arabic task
 * title in an English sentence (or an English one in Arabic) no longer reorders the words and
 * punctuation around it.
 */
export function createTranslator(locale: Locale, messages: Messages): TranslateFn {
  const tag = INTL_LOCALE[locale];
  const plural = new Intl.PluralRules(tag);
  const numberFmt = new Intl.NumberFormat(tag);
  const ctx = { plural, number: (n: number) => numberFmt.format(n), isolate: true };
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
