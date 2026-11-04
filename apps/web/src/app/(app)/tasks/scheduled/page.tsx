import type { Metadata } from 'next';
import { ScheduledScreen } from '@/features/schedules/ScheduledScreen';
import { getServerI18n } from '@/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerI18n();
  return { title: t('tasks.views.scheduled') };
}

/** Task Center › Scheduled: requests JARVIS runs on a recurrence. */
export default function ScheduledPage() {
  return <ScheduledScreen />;
}
