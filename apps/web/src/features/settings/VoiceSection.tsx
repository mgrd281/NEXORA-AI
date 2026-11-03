'use client';

import type { Me, Preferences } from '@jarvis/contracts';
import { Select } from '@/components/ui/Field';
import { LANGUAGE_NAMES } from '@/i18n/config';
import { useI18n } from '@/i18n/I18nProvider';
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
        <RecognitionRow me={me} />
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
