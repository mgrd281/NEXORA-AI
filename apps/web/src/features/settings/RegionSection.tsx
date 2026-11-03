'use client';

import type { Locale, Me } from '@jarvis/contracts';
import { useMemo, useSyncExternalStore } from 'react';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Field';
import { LANGUAGE_NAMES, LOCALES } from '@/i18n/config';
import { useI18n } from '@/i18n/I18nProvider';
import { useApplyAppearance } from '@/lib/preferences';
import { useSaveMe } from './api';
import { SaveStatus, SettingRow, SettingsCard } from './controls';
import { SettingsSection } from './SettingsSection';
import { deviceTimeZone, timeZoneOptions, zoneDisplayName } from './timeZones';

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
  const { t, f } = useI18n();
  const saver = useSaveMe();
  const value = saver.variables?.timeZone ?? me.timeZone;
  // ~400 zones with their current offsets, in the interface language.
  const list = useMemo(
    () => timeZoneOptions(me.timeZone, f.intlLocale),
    [me.timeZone, f.intlLocale],
  );
  const device = useSyncExternalStore(noopSubscribe, deviceTimeZone, () => null);
  const offerDevice = device !== null && device !== me.timeZone;

  const save = (timeZone: string) => {
    if (timeZone === me.timeZone || saver.pending) return;
    saver.save({ timeZone });
  };

  return (
    <SettingRow>
      <Select
        label={t('settings.region.timeZone')}
        hint={t('settings.region.timeZoneHint')}
        value={value}
        onChange={(e) => save(e.target.value)}
      >
        {list.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
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
