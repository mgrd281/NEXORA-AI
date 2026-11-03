'use client';

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import type { MessageKey, Messages } from './catalog';
import { dirFor, SPEECH_LOCALE, type Direction, type Locale, type SpeechLocale } from './config';
import { createFormatters, type Formatters } from './format';
import { createTranslator, translateDynamic, type TranslateFn } from './translate';
import type { MessageParams } from './types';

export interface I18n {
  locale: Locale;
  dir: Direction;
  /** Default speech recognition / synthesis language for the interface locale. */
  speechLocale: SpeechLocale;
  messages: Messages;
  t: TranslateFn;
  /** Translate a key assembled at runtime, e.g. `home.${suggestion.messageKey}`. */
  tDynamic: (key: string, fallback: MessageKey, params?: MessageParams) => string;
  /** Number, date, time, relative time, currency and list formatters for this locale. */
  f: Formatters;
  /** The account's IANA time zone once known (me.timeZone); the browser's until then. */
  timeZone: string | undefined;
  setTimeZone: (timeZone: string | undefined) => void;
}

const I18nContext = createContext<I18n | null>(null);

export function I18nProvider({
  locale,
  messages,
  timeZone: initialTimeZone,
  children,
}: {
  locale: Locale;
  messages: Messages;
  timeZone?: string;
  children: ReactNode;
}) {
  const [timeZone, setTimeZone] = useState<string | undefined>(initialTimeZone);
  const value = useMemo<I18n>(() => {
    const t = createTranslator(locale, messages);
    return {
      locale,
      dir: dirFor(locale),
      speechLocale: SPEECH_LOCALE[locale],
      messages,
      t,
      tDynamic: (key, fallback, params) => translateDynamic(t, messages, key, fallback, params),
      f: createFormatters(locale, timeZone),
      timeZone,
      setTimeZone,
    };
  }, [locale, messages, timeZone]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used inside <I18nProvider>');
  return ctx;
}

/** Shorthand for the translate function. */
export function useT(): TranslateFn {
  return useI18n().t;
}
