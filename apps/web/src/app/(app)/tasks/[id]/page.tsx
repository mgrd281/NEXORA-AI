import type { Metadata } from 'next';
import { TaskDetailScreen } from '@/features/tasks/TaskDetailScreen';
import { getServerI18n } from '@/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerI18n();
  return { title: t('tasks.detailTitle') };
}

/** Task detail: plan, actions, evidence and history of one task. */
export default async function TaskDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Keyed by id so per-task state (dialogs, streamed text, expanded steps) starts fresh.
  return <TaskDetailScreen key={id} id={id} />;
}
