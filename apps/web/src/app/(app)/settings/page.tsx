import type { Metadata } from 'next';
import { SettingsScreen } from '@/features/settings/SettingsScreen';
import { getServerI18n } from '@/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerI18n();
  return { title: t('settings.title') };
}

export default function SettingsPage() {
  return <SettingsScreen />;
}
