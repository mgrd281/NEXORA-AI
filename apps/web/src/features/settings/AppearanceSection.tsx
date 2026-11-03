'use client';

import type { Me, ThemePreference } from '@jarvis/contracts';
import { Monitor, Moon, Sun } from 'lucide-react';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { useI18n } from '@/i18n/I18nProvider';
import { useApplyAppearance } from '@/lib/preferences';
import { useSaveMe } from './api';
import { SaveStatus, SettingRow, SettingsCard } from './controls';
import { SettingsSection } from './SettingsSection';
import styles from './settings.module.css';

const THEME_ICONS = { system: Monitor, light: Sun, dark: Moon } as const;

export function AppearanceSection({ me }: { me: Me }) {
  const { t } = useI18n();
  const saver = useSaveMe();
  const applyAppearance = useApplyAppearance();
  const value = saver.variables?.theme ?? me.theme;

  function change(theme: ThemePreference) {
    if (theme === me.theme || saver.pending) return;
    const previous = me.theme;
    // A theme is purely visual, so it applies at once and is put back if the save fails.
    applyAppearance({ theme });
    saver.save({ theme }, { onError: () => applyAppearance({ theme: previous }) });
  }

  return (
    <SettingsSection id="appearance" title={t('settings.sections.appearance')}>
      <SettingsCard>
        <SettingRow>
          <SegmentedControl
            legend={t('settings.appearance.theme')}
            showLegend
            value={value}
            onChange={change}
            options={(['system', 'light', 'dark'] as const).map((v) => ({
              value: v,
              label: t(`common.theme.${v}`),
              icon: THEME_ICONS[v],
            }))}
          />
          <p className={styles.note}>{t('settings.appearance.systemHint')}</p>
          <SaveStatus state={saver.state} error={saver.error} />
        </SettingRow>
      </SettingsCard>
    </SettingsSection>
  );
}
