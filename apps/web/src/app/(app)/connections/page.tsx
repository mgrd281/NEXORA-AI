import type { Metadata } from 'next';
import { ConnectionsScreen } from '@/features/connections/ConnectionsScreen';
import { getServerI18n } from '@/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerI18n();
  return { title: t('connections.title') };
}

export default function ConnectionsPage() {
  return <ConnectionsScreen />;
}
