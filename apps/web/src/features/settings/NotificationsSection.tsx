'use client';

import type { Me, Preferences } from '@jarvis/contracts';
import { useI18n } from '@/i18n/I18nProvider';
import { PreferenceSwitch, SettingRow, SettingsCard } from './controls';
import { SettingsSection } from './SettingsSection';
import styles from './settings.module.css';

type Kind = keyof Preferences['notifications'];
const KINDS: readonly Kind[] = ['approvalRequested', 'taskCompleted', 'taskFailed'];

export function NotificationsSection({ me }: { me: Me }) {
  const { t } = useI18n();
  return (
    <SettingsSection
      id="notifications"
      title={t('settings.sections.notifications')}
      description={t('settings.notifications.description')}
    >
      <SettingsCard>
        {KINDS.map((kind) => (
          <PreferenceSwitch
            key={kind}
            me={me}
            label={t(`settings.notifications.${kind}`)}
            description={t(`settings.notifications.${kind}Description`)}
            read={(m) => m.preferences.notifications[kind]}
            write={(v) => ({ preferences: { notifications: { [kind]: v } } })}
          />
        ))}
        <SettingRow>
          <p className={styles.note}>{t('settings.notifications.connectionNote')}</p>
        </SettingRow>
      </SettingsCard>
    </SettingsSection>
  );
}
