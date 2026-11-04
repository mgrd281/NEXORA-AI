import type { Metadata } from 'next';
import { CallsScreen } from '@/features/calls/CallsScreen';
import { getServerI18n } from '@/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerI18n();
  return { title: t('tasks.views.calls') };
}

/** Task Center › Calls: every phone call JARVIS placed or tried to place. */
export default function CallsPage() {
  return <CallsScreen />;
}
