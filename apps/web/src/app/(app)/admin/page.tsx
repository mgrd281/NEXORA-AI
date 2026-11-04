import type { Metadata } from 'next';
import { AdminScope } from '@/features/admin/AdminLocale';
import { AdminScreen } from '@/features/admin/AdminScreen';
import { getAdminI18n } from '@/features/admin/server';

/** The admin page is German or Arabic (its own cookie), whatever the profile's language. */
export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getAdminI18n();
  return { title: t('admin.title') };
}

export default async function AdminPage() {
  const { locale, messages } = await getAdminI18n();
  return (
    <AdminScope locale={locale} messages={messages}>
      <AdminScreen />
    </AdminScope>
  );
}
