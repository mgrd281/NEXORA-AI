import type { Metadata } from 'next';
import { getServerI18n } from '@/i18n/server';
import { safeNextPath } from '@/lib/safe-next';
import { SignInForm } from './SignInForm';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerI18n();
  return { title: t('shell.pageTitles.signIn') };
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const next = typeof params.next === 'string' ? params.next : null;
  const reason = typeof params.reason === 'string' ? params.reason : null;
  return <SignInForm next={safeNextPath(next)} sessionEnded={reason === 'expired'} />;
}
