'use client';

import { Page } from '@/components/shell/Page';
import { ErrorBanner } from '@/components/ui/Banner';
import { Skeleton } from '@/components/ui/Skeleton';
import { useI18n } from '@/i18n/I18nProvider';
import { useMe } from '@/lib/api/hooks';
import { DeveloperSection } from '@/features/webhooks/DeveloperSection';
import { useConnections } from './api';
import { EmailCard } from './EmailCard';
import { WebAccessCard } from './WebAccessCard';
import styles from './connections.module.css';

/**
 * What JARVIS can access, and the controls to revoke it. Only the connection types this build
 * implements (web access and SMTP email) are shown. `connection.changed` events refresh the
 * list (see lib/events/invalidation.ts).
 */
export function ConnectionsScreen() {
  const { t } = useI18n();
  const me = useMe();
  const connections = useConnections();
  const items = connections.data?.items ?? [];
  const web = items.find((c) => c.provider === 'web') ?? null;
  const smtp = items.find((c) => c.provider === 'smtp') ?? null;

  return (
    <Page title={t('connections.title')} description={t('connections.description')}>
      {connections.isPending ? (
        <div className={styles.cards} aria-busy="true">
          <span className="visually-hidden" role="status">
            {t('connections.loading')}
          </span>
          {[0, 1].map((i) => (
            <div key={i} className={styles.skeletonCard} aria-hidden="true">
              <Skeleton width={40} height={40} radius="md" />
              <div className={styles.skeletonLines}>
                <Skeleton width="30%" height={16} />
                <Skeleton width="70%" height={12} />
              </div>
            </div>
          ))}
        </div>
      ) : connections.isError && !connections.data ? (
        <ErrorBanner
          error={connections.error}
          onRetry={() => void connections.refetch()}
          retrying={connections.isFetching}
        />
      ) : (
        <div className={styles.cards}>
          <WebAccessCard connection={web} />
          <EmailCard connection={smtp} me={me.data} />
        </div>
      )}
      <DeveloperSection />
    </Page>
  );
}
