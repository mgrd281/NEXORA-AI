import type { Metadata } from 'next';
import { MemoryScreen } from '@/features/memory/MemoryScreen';
import { getServerI18n } from '@/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerI18n();
  return { title: t('memory.title') };
}

export default async function MemoryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { q } = await searchParams;
  const initialQuery = (Array.isArray(q) ? q[0] : q)?.slice(0, 200) ?? '';
  return <MemoryScreen initialQuery={initialQuery} />;
}
