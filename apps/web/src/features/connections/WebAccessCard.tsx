'use client';

import type { Connection } from '@jarvis/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BookOpen, Globe, ShieldBan, UserX } from 'lucide-react';
import { useId } from 'react';
import { ErrorBanner } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { useToast } from '@/components/ui/Toast';
import { useI18n } from '@/i18n/I18nProvider';
import { api, type ApiError } from '@/lib/api/client';
import { forgetConnection, storeConnection } from './api';
import { ConnectionCard } from './ConnectionCard';
import styles from './connections.module.css';

export function WebAccessCard({ connection }: { connection: Connection | null }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const listId = useId();

  const enable = useMutation<Connection, ApiError>({
    mutationFn: () => api.call('enableWebAccess'),
    onSuccess: (saved) => {
      storeConnection(queryClient, saved);
      toast({ message: t('connections.web.enabled') });
    },
  });
  const disconnect = useMutation<void, ApiError, string>({
    mutationFn: (id) => api.call('deleteConnection', { params: { id } }),
    onSuccess: (_void, id) => {
      forgetConnection(queryClient, id);
      toast({ message: t('connections.web.disconnected') });
    },
  });
  const failed = enable.error ?? disconnect.error;

  return (
    <ConnectionCard
      icon={Globe}
      title={t('connections.web.title')}
      summary={t('connections.web.summary')}
      status={connection?.status ?? null}
      footer={
        <>
          <span className={styles.meta}>
            {connection && (
              <RelativeTime
                value={connection.lastVerifiedAt ?? connection.createdAt}
                format={(time) => t('connections.web.since', { time })}
              />
            )}
          </span>
          <div className={styles.actions}>
            {/* One button that changes role, so keyboard focus stays put after the change. */}
            <Button
              variant={connection ? 'danger' : 'primary'}
              loading={enable.isPending || disconnect.isPending}
              onClick={() => {
                enable.reset();
                disconnect.reset();
                if (connection) disconnect.mutate(connection.id);
                else enable.mutate();
              }}
            >
              {connection ? t('connections.web.disconnect') : t('connections.web.enable')}
            </Button>
          </div>
        </>
      }
    >
      <h3 id={listId} className={styles.subTitle}>
        {t('connections.web.allowsTitle')}
      </h3>
      <ul className={styles.facts} aria-labelledby={listId}>
        <li>
          <Icon icon={BookOpen} size={16} />
          <span>{t('connections.web.allows.read')}</span>
        </li>
        <li>
          <Icon icon={ShieldBan} size={16} />
          <span>{t('connections.web.allows.privateNetworks')}</span>
        </li>
        <li>
          <Icon icon={UserX} size={16} />
          <span>{t('connections.web.allows.noBrowser')}</span>
        </li>
      </ul>
      {failed && <ErrorBanner error={failed} />}
    </ConnectionCard>
  );
}
