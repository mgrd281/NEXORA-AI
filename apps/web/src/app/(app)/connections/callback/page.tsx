import type { Metadata } from 'next';
import { CallbackScreen } from '@/features/connections/CallbackScreen';
import { getServerI18n } from '@/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerI18n();
  // The provider's code is in this page's address until the page removes it: never send it on.
  return { title: t('connections.callback.title'), referrer: 'no-referrer' };
}

export default function ConnectionsCallbackPage() {
  return <CallbackScreen />;
}
