'use client';

import type { Locale } from '@jarvis/contracts';
import { useCallback, useState } from 'react';
import { useI18n } from '@/i18n/I18nProvider';
import { useMe } from '@/lib/api/hooks';
import { createBrowserSynthesizer } from './engine/browser';

/**
 * Returns speak(text, lang?) that reads text aloud only when the account enabled
 * preferences.voice.speakResponses (and the browser supports speech synthesis), with the
 * account's speaking rate and voice for that language (Settings › Voice). Use it when a task
 * started by voice (TaskSummary.source === 'voice') completes.
 */
export function useSpeakResponses(): {
  enabled: boolean;
  speak: (text: string, lang?: string) => boolean;
} {
  const me = useMe();
  const { speechLocale } = useI18n();
  const [synth] = useState(() => createBrowserSynthesizer());
  const voice = me.data?.preferences.voice;
  const enabled = (voice?.speakResponses ?? false) && synth.supported;
  const rate = voice?.speakingRate ?? 1;
  const voiceNames = voice?.voiceNames;
  const say = useCallback(
    (text: string, lang?: string) => {
      if (!enabled || !text.trim()) return false;
      const target = lang ?? speechLocale;
      synth.cancel();
      synth.speak(
        text,
        {
          lang: target,
          rate,
          voiceId: voiceNames?.[target.slice(0, 2) as Locale] ?? null,
        },
        { onEnd: () => undefined, onError: () => undefined },
      );
      return true;
    },
    [enabled, speechLocale, synth, rate, voiceNames],
  );
  return { enabled, speak: say };
}
