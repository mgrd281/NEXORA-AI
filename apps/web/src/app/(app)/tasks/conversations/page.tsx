import type { Metadata } from 'next';
import { ConversationsScreen } from '@/features/conversations/ConversationsScreen';
import { getServerI18n } from '@/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerI18n();
  return { title: t('tasks.views.conversations') };
}

/** Task Center › Conversations: the history of requests with their follow-ups (?q= search). */
export default async function ConversationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { q } = await searchParams;
  const initialQuery = (Array.isArray(q) ? q[0] : q)?.slice(0, 200) ?? '';
  return <ConversationsScreen initialQuery={initialQuery} />;
}
