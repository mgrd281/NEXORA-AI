import { Compass } from 'lucide-react';
import type { Metadata } from 'next';
import { ButtonLink } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { getServerI18n } from '@/i18n/server';
import styles from './not-found.module.css';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerI18n();
  return { title: t('shell.pageTitles.notFound') };
}

export default async function NotFound() {
  const { t } = await getServerI18n();
  return (
    <main className={styles.page}>
      <h1 className={styles.title}>{t('shell.notFound.title')}</h1>
      <EmptyState
        icon={Compass}
        message={t('shell.notFound.body')}
        action={
          <ButtonLink href="/" variant="primary">
            {t('shell.notFound.home')}
          </ButtonLink>
        }
      />
    </main>
  );
}
