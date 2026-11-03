'use client';

import { useCallback } from 'react';
import { useI18n } from '@/i18n/I18nProvider';
import { useMe } from '@/lib/api/hooks';
import { canSpeak, speak } from './speech';

/**
 * Returns speak(text, lang?) that reads text aloud only when the account enabled
 * preferences.voice.speakResponses (and the browser supports speech synthesis). Use it when a
 * task started by voice (TaskSummary.source === 'voice') completes.
 */
export function useSpeakResponses(): {
  enabled: boolean;
  speak: (text: string, lang?: string) => boolean;
} {
  const me = useMe();
  const { speechLocale } = useI18n();
  const enabled = (me.data?.preferences.voice.speakResponses ?? false) && canSpeak();
  const say = useCallback(
    (text: string, lang?: string) => (enabled ? speak(text, lang ?? speechLocale) : false),
    [enabled, speechLocale],
  );
  return { enabled, speak: say };
}
