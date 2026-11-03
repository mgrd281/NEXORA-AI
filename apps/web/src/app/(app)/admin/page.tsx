import type { Metadata } from 'next';
import { AdminScreen } from '@/features/admin/AdminScreen';
import { getServerI18n } from '@/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerI18n();
  return { title: t('admin.title') };
}

export default function AdminPage() {
  return <AdminScreen />;
}
