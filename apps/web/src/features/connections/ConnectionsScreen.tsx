'use client';

import type { ConnectionProviderInfo } from '@jarvis/contracts';
import { Page } from '@/components/shell/Page';
import { ErrorBanner } from '@/components/ui/Banner';
import { Skeleton } from '@/components/ui/Skeleton';
import { useI18n } from '@/i18n/I18nProvider';
import { useMe } from '@/lib/api/hooks';
import { DeveloperSection } from '@/features/webhooks/DeveloperSection';
import { useConnectionProviders, useConnections } from './api';
import { EmailCard } from './EmailCard';
import { OAuthCard } from './OAuthCard';
import { connectionOf, OAUTH_PROVIDERS } from './oauth';
import { WebAccessCard } from './WebAccessCard';
import styles from './connections.module.css';

/**
 * What JARVIS can access, and the controls to revoke it: the Google and Microsoft accounts
 * (each as this server offers it — or honestly "not configured on this server"), SMTP email
 * and web access. `connection.changed` events refresh the list (lib/events/invalidation.ts).
 */
export function ConnectionsScreen() {
  const { t } = useI18n();
  const me = useMe();
  const connections = useConnections();
  const providers = useConnectionProviders();
  const items = connections.data?.items ?? [];
  const web = items.find((c) => c.provider === 'web') ?? null;
  const smtp = items.find((c) => c.provider === 'smtp') ?? null;
  const oauth = OAUTH_PROVIDERS.map((p) =>
    providers.data?.items.find((i) => i.provider === p && i.kind === 'oauth'),
  ).filter((i): i is ConnectionProviderInfo => i !== undefined);

  return (
    <Page title={t('connections.title')} description={t('connections.description')}>
      {connections.isPending ? (
        <div className={styles.cards} aria-busy="true">
          <span className="visually-hidden" role="status">
            {t('connections.loading')}
          </span>
          {[0, 1, 2].map((i) => (
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
          {providers.isError && !providers.data && (
            <ErrorBanner
              error={providers.error}
              onRetry={() => void providers.refetch()}
              retrying={providers.isFetching}
            />
          )}
          {oauth.map((info) => (
            <OAuthCard
              key={info.provider}
              info={info}
              connection={connectionOf(info.provider as 'google' | 'microsoft', items)}
            />
          ))}
          <EmailCard connection={smtp} me={me.data} />
          <WebAccessCard connection={web} />
        </div>
      )}
      <DeveloperSection />
    </Page>
  );
}
