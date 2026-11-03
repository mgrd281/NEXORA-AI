import type { Metadata } from 'next';
import { Suspense } from 'react';
import { TaskCenter } from '@/features/tasks/TaskCenter';
import { getServerI18n } from '@/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerI18n();
  return { title: t('tasks.title') };
}

/** Task Center: every task, filtered by ?status=, live. */
export default function TasksPage() {
  return (
    // useSearchParams (the ?status= filter) needs a Suspense boundary when prerendered.
    <Suspense>
      <TaskCenter />
    </Suspense>
  );
}
