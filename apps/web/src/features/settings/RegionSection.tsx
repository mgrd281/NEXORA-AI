'use client';

import type { Locale, Me } from '@jarvis/contracts';
import { useSyncExternalStore } from 'react';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Field';
import { LANGUAGE_NAMES, LOCALES } from '@/i18n/config';
import { useI18n } from '@/i18n/I18nProvider';
import { useTimeZones } from '@/lib/api/hooks';
import { useApplyAppearance } from '@/lib/preferences';
import { useSaveMe } from './api';
import { SaveStatus, SettingRow, SettingsCard } from './controls';
import { SettingsSection } from './SettingsSection';
import { deviceTimeZone, zoneDisplayName } from './timeZones';
import { TimeZoneSelect } from './TimeZoneSelect';

const noopSubscribe = () => () => undefined;

export function RegionSection({ me }: { me: Me }) {
  const { t } = useI18n();
  return (
    <SettingsSection id="language" title={t('settings.sections.language')}>
      <SettingsCard>
        <LanguageRow me={me} />
        <TimeZoneRow me={me} />
      </SettingsCard>
    </SettingsSection>
  );
}

function LanguageRow({ me }: { me: Me }) {
  const { t } = useI18n();
  const saver = useSaveMe();
  const applyAppearance = useApplyAppearance();
  const value = saver.variables?.locale ?? me.locale;
  return (
    <SettingRow>
      <Select
        label={t('settings.language')}
        hint={t('settings.region.languageHint')}
        value={value}
        onChange={(e) => {
          const locale = e.target.value as Locale;
          if (locale === me.locale || saver.pending) return;
          // The new language applies once the server has it: cookie, <html lang/dir>, catalog.
          saver.save({ locale }, { onSuccess: (next) => applyAppearance({ locale: next.locale }) });
        }}
      >
        {LOCALES.map((l) => (
          <option key={l} value={l} lang={l}>
            {LANGUAGE_NAMES[l]}
          </option>
        ))}
      </Select>
      <SaveStatus state={saver.state} error={saver.error} />
    </SettingRow>
  );
}

function TimeZoneRow({ me }: { me: Me }) {
  const { t } = useI18n();
  const saver = useSaveMe();
  const zones = useTimeZones();
  const value = saver.variables?.timeZone ?? me.timeZone;
  const device = useSyncExternalStore(noopSubscribe, deviceTimeZone, () => null);
  // Offer the device's zone only when the server accepts it (it is in the server's list).
  const offerDevice =
    device !== null &&
    device !== me.timeZone &&
    (zones.data?.items.some((z) => z.id === device) ?? false);

  const save = (timeZone: string) => {
    if (timeZone === me.timeZone || saver.pending) return;
    saver.save({ timeZone });
  };

  return (
    <SettingRow>
      <TimeZoneSelect
        label={t('settings.region.timeZone')}
        hint={t('settings.region.timeZoneHint')}
        value={value}
        onChange={save}
      />
      {offerDevice && (
        <div>
          <Button size="sm" variant="secondary" onClick={() => save(device)}>
            {t('settings.region.useDevice', { zone: zoneDisplayName(device) })}
          </Button>
        </div>
      )}
      <SaveStatus state={saver.state} error={saver.error} />
    </SettingRow>
  );
}
