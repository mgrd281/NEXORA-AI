import type { Metadata } from 'next';
import { HomeScreen } from '@/features/home/HomeScreen';
import { getServerI18n } from '@/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerI18n();
  return { title: t('home.title') };
}

/** Home: what needs me, what is happening, ask for something. */
export default function HomePage() {
  return <HomeScreen />;
}
