import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { parseLocale } from '@/i18n/config';
import { catalogs } from '@/i18n/messages';
import { getServerI18n } from '@/i18n/server';
import { Gallery } from './Gallery';

export const metadata: Metadata = { title: 'Components', robots: { index: false } };

/**
 * Development-only component gallery: every Meridian component in every state, switchable
 * between light/dark and en/de/ar (LTR/RTL). Returns 404 in production.
 */
export default async function ComponentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === 'production') notFound();
  const params = await searchParams;
  const { locale } = await getServerI18n();
  const initialLocale =
    parseLocale(typeof params.locale === 'string' ? params.locale : null) ?? locale;
  return <Gallery catalogs={catalogs} initialLocale={initialLocale} />;
}
