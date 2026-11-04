'use client';

import type { Locale, Me, Preferences } from '@jarvis/contracts';
import { VOICE_LIMITS } from '@jarvis/contracts';
import { Volume2 } from 'lucide-react';
import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { Button } from '@/components/ui/Button';
import { Field, Select } from '@/components/ui/Field';
import { createBrowserSynthesizer, voicesFor } from '@/components/voice/engine/browser';
import type { SynthVoice } from '@/components/voice/engine/types';
import { LANGUAGE_NAMES, SPEECH_LOCALE } from '@/i18n/config';
import { useI18n } from '@/i18n/I18nProvider';
import { stripIsolates } from '@/i18n/translate';
import { useSaveMe } from './api';
import { PreferenceSwitch, SaveStatus, SettingRow, SettingsCard } from './controls';
import { SettingsSection } from './SettingsSection';
import styles from './settings.module.css';

type Recognition = Preferences['voice']['recognitionLocale'];

const RECOGNITION_KEYS = {
  'en-US': 'voice.languages.enUS',
  'de-DE': 'voice.languages.deDE',
  'ar-SA': 'voice.languages.arSA',
} as const;

const RECOGNITION_LANG = { 'en-US': 'en', 'de-DE': 'de', 'ar-SA': 'ar' } as const;
const VOICE_LANGUAGES: readonly Locale[] = ['en', 'de', 'ar'];

/**
 * Settings › Voice: read results aloud, voice conversation mode, the recognition language, how
 * fast JARVIS speaks, how long a pause ends what you say (WCAG 2.2.1), and the voice per
 * language — chosen from speechSynthesis.getVoices() on this device, with a preview.
 */
export function VoiceSection({ me }: { me: Me }) {
  const { t } = useI18n();
  return (
    <SettingsSection id="voice" title={t('settings.sections.voice')}>
      <SettingsCard>
        <PreferenceSwitch
          me={me}
          label={t('settings.voice.speak')}
          description={t('settings.voice.speakDescription')}
          read={(m) => m.preferences.voice.speakResponses}
          write={(v) => ({ preferences: { voice: { speakResponses: v } } })}
        />
        <PreferenceSwitch
          me={me}
          label={t('settings.voice.conversation')}
          description={t('settings.voice.conversationDescription')}
          read={(m) => m.preferences.voice.conversationMode}
          write={(v) => ({ preferences: { voice: { conversationMode: v } } })}
        />
        <RecognitionRow me={me} />
        <RangeRow
          me={me}
          kind="rate"
          label={t('settings.voice.rate')}
          hint={t('settings.voice.rateHint')}
          min={VOICE_LIMITS.speakingRate.min}
          max={VOICE_LIMITS.speakingRate.max}
          step={0.1}
          read={(m) => m.preferences.voice.speakingRate}
          write={(v) => ({ preferences: { voice: { speakingRate: v } } })}
        />
        <RangeRow
          me={me}
          kind="pause"
          label={t('settings.voice.pause')}
          hint={t('settings.voice.pauseHint')}
          min={VOICE_LIMITS.endOfSpeechSilenceMs.min}
          max={VOICE_LIMITS.endOfSpeechSilenceMs.max}
          step={100}
          read={(m) => m.preferences.voice.endOfSpeechSilenceMs}
          write={(v) => ({ preferences: { voice: { endOfSpeechSilenceMs: v } } })}
        />
        <VoicesRow me={me} />
      </SettingsCard>
    </SettingsSection>
  );
}

function RecognitionRow({ me }: { me: Me }) {
  const { t, locale } = useI18n();
  const saver = useSaveMe();
  const value =
    saver.variables?.preferences?.voice?.recognitionLocale ??
    me.preferences.voice.recognitionLocale;
  return (
    <SettingRow>
      <Select
        label={t('settings.voice.recognition')}
        hint={t('settings.voice.recognitionHint')}
        value={value}
        onChange={(e) => {
          const next = e.target.value as Recognition;
          if (next === me.preferences.voice.recognitionLocale || saver.pending) return;
          saver.save({ preferences: { voice: { recognitionLocale: next } } });
        }}
      >
        <option value="auto">
          {t('settings.voice.recognitionAuto', { language: LANGUAGE_NAMES[locale] })}
        </option>
        {(Object.keys(RECOGNITION_KEYS) as Array<keyof typeof RECOGNITION_KEYS>).map((code) => (
          <option key={code} value={code} lang={RECOGNITION_LANG[code]}>
            {t(RECOGNITION_KEYS[code])}
          </option>
        ))}
      </Select>
      <p className={styles.note}>{t('voice.privacy')}</p>
      <SaveStatus state={saver.state} error={saver.error} />
    </SettingRow>
  );
}

/** How long a value change waits before it is saved (dragging the slider sends one PATCH). */
const SETTLE_MS = 500;

/**
 * A slider that saves once it settles. Keyboard: arrows / Page Up / Page Down / Home / End (the
 * native range input); the value is also spoken as text (aria-valuetext).
 */
function RangeRow({
  me,
  kind,
  label,
  hint,
  min,
  max,
  step,
  read,
  write,
}: {
  me: Me;
  kind: 'rate' | 'pause';
  label: string;
  hint: string;
  min: number;
  max: number;
  step: number;
  read: (me: Me) => number;
  write: (value: number) => Parameters<ReturnType<typeof useSaveMe>['save']>[0];
}) {
  const { t, f } = useI18n();
  const saver = useSaveMe();
  const saved = read(me);
  const [draft, setDraft] = useState<number | null>(null);
  const value = draft ?? saved;
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const text =
    kind === 'rate'
      ? t('settings.voice.rateValue', {
          rate: f.number(value, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
        })
      : t('settings.voice.pauseValue', {
          seconds: f.number(value / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
        });

  const commit = (next: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      if (next === read(me)) {
        setDraft(null);
        return;
      }
      saver.save(write(next), {
        onSuccess: () => setDraft((d) => (d === next ? null : d)),
        onError: () => setDraft(null),
      });
    }, SETTLE_MS);
  };

  return (
    <SettingRow>
      <Field label={label} hint={hint} labelAside={<span className="tabular">{text}</span>}>
        {(control) => (
          <input
            {...control}
            type="range"
            className={styles.range}
            min={min}
            max={max}
            step={step}
            value={value}
            aria-valuetext={stripIsolates(text)}
            onChange={(e) => {
              const next = Number(e.target.value);
              setDraft(next);
              commit(next);
            }}
          />
        )}
      </Field>
      <SaveStatus state={saver.state} error={saver.error} />
    </SettingRow>
  );
}

const EMPTY_VOICES: SynthVoice[] = [];
const noopSubscribe = () => () => undefined;
const voiceCache = new WeakMap<object, { key: string; list: SynthVoice[] }>();

/** The device's voices, as a stable snapshot (they load asynchronously in some browsers). */
function voicesSnapshot(synth: ReturnType<typeof createBrowserSynthesizer>): SynthVoice[] {
  const list = synth.voices();
  const key = list.map((v) => `${v.id}|${v.lang}|${v.local}`).join(',');
  const cached = voiceCache.get(synth);
  if (cached && cached.key === key) return cached.list;
  voiceCache.set(synth, { key, list });
  return list;
}

/**
 * The device's speech synthesis and voices. The server render (and hydration) says "no voices";
 * the browser's own state follows right after, so the markup never mismatches.
 */
function useDeviceVoices() {
  const [synth] = useState(() => createBrowserSynthesizer());
  const supported = useSyncExternalStore(
    noopSubscribe,
    () => synth.supported,
    () => false,
  );
  const voices = useSyncExternalStore(
    (onChange) => synth.onVoicesChanged(onChange),
    () => voicesSnapshot(synth),
    () => EMPTY_VOICES,
  );
  return { synth, supported, voices };
}

function VoicesRow({ me }: { me: Me }) {
  const { t } = useI18n();
  const { synth, supported, voices } = useDeviceVoices();
  const headingId = useId();
  if (!supported) {
    return (
      <SettingRow>
        <h3 className={styles.rowTitle}>{t('settings.voice.voices')}</h3>
        <p className={styles.rowText}>{t('settings.voice.noSpeech')}</p>
      </SettingRow>
    );
  }
  const anyOnline = voices.some((v) => !v.local);
  return (
    <SettingRow>
      <div role="group" aria-labelledby={headingId} className={styles.voices}>
        <div>
          <h3 id={headingId} className={styles.rowTitle}>
            {t('settings.voice.voices')}
          </h3>
          <p className={styles.rowText}>{t('settings.voice.voicesHint')}</p>
        </div>
        {VOICE_LANGUAGES.map((language) => (
          <VoicePicker
            key={language}
            me={me}
            language={language}
            voices={voicesFor(voices, SPEECH_LOCALE[language])}
            preview={(voiceId) =>
              synth.speak(
                t(`voice.samples.${language}`),
                {
                  lang: SPEECH_LOCALE[language],
                  voiceId,
                  rate: me.preferences.voice.speakingRate,
                },
                { onEnd: () => undefined, onError: () => undefined },
              )
            }
            stop={() => synth.cancel()}
          />
        ))}
        {anyOnline && <p className={styles.note}>{t('settings.voice.onlineNote')}</p>}
      </div>
    </SettingRow>
  );
}

function VoicePicker({
  me,
  language,
  voices,
  preview,
  stop,
}: {
  me: Me;
  language: Locale;
  voices: SynthVoice[];
  preview: (voiceId: string | null) => void;
  stop: () => void;
}) {
  const { t } = useI18n();
  const saver = useSaveMe();
  const saved = me.preferences.voice.voiceNames[language];
  const pending = saver.variables?.preferences?.voice?.voiceNames;
  const value = (pending && language in pending ? pending[language] : saved) ?? '';
  const missing = value !== '' && !voices.some((v) => v.id === value);
  const name = LANGUAGE_NAMES[language];
  useEffect(() => stop, [stop]);
  return (
    <div className={styles.voiceRow}>
      <Select
        label={t('settings.voice.voiceFor', { language: name })}
        size="sm"
        value={value}
        hint={
          missing
            ? t('settings.voice.voiceMissing')
            : voices.length === 0
              ? t('settings.voice.noVoicesFor', { language: name })
              : undefined
        }
        onChange={(e) => {
          const next = e.target.value || null;
          if (next === saved || saver.pending) return;
          saver.save({ preferences: { voice: { voiceNames: { [language]: next } } } });
        }}
        fieldClassName={styles.voiceSelect}
      >
        <option value="">{t('settings.voice.voiceDefault')}</option>
        {missing && <option value={value}>{t('settings.voice.voiceMissingOption')}</option>}
        {voices.map((v) => (
          <option key={v.id} value={v.id} lang={v.lang}>
            {v.local ? v.name : t('settings.voice.voiceOnline', { name: v.name })}
          </option>
        ))}
      </Select>
      <Button
        size="sm"
        icon={Volume2}
        onClick={() => {
          stop();
          preview(value && !missing ? value : null);
        }}
        aria-label={t('settings.voice.previewLabel', { language: name })}
        className={styles.preview}
      >
        {t('settings.voice.preview')}
      </Button>
      <SaveStatus state={saver.state} error={saver.error} className={styles.voiceStatus} />
    </div>
  );
}
