'use client';

import type { Notification } from '@jarvis/contracts';
import type { LucideIcon } from 'lucide-react';
import { BellOff, CircleAlert, CircleCheck, Hand, PlugZap } from 'lucide-react';
import Link from 'next/link';
import { ErrorBanner } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { SkeletonRow } from '@/components/ui/Skeleton';
import { useI18n } from '@/i18n/I18nProvider';
import { useMarkNotificationsRead, useNotifications } from '@/lib/api/hooks';
import { cx } from '@/lib/cx';
import styles from './NotificationsPanel.module.css';

const KIND_ICON: Record<Notification['kind'], { icon: LucideIcon; tone: string }> = {
  approval_requested: { icon: Hand, tone: styles.warning ?? '' },
  task_completed: { icon: CircleCheck, tone: styles.success ?? '' },
  task_failed: { icon: CircleAlert, tone: styles.danger ?? '' },
  connection_error: { icon: PlugZap, tone: styles.danger ?? '' },
};

function hrefFor(n: Notification): string {
  if (n.kind === 'connection_error') return '/connections';
  return n.taskId ? `/tasks/${n.taskId}` : '/tasks';
}

/** The notifications list (inside the desktop popover or the mobile sheet). */
export function NotificationsPanel({
  onNavigate,
  showTitle = true,
}: {
  onNavigate: () => void;
  showTitle?: boolean;
}) {
  const { t } = useI18n();
  const query = useNotifications();
  const markRead = useMarkNotificationsRead();
  const items = query.data?.items ?? [];
  const unread = items.filter((n) => n.readAt === null);

  const message = (n: Notification) => {
    const title = n.data.taskTitle;
    return title
      ? t(`notifications.kinds.${n.kind}`, { taskTitle: title })
      : t(`notifications.kindsUntitled.${n.kind}`);
  };

  return (
    <div className={cx(styles.panel, !showTitle && styles.inSheet)}>
      <div className={cx(styles.header, !showTitle && styles.headerBare)}>
        {showTitle && <h2 className={styles.title}>{t('notifications.title')}</h2>}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => markRead.mutate(undefined)}
          disabled={unread.length === 0}
          loading={markRead.isPending && markRead.variables === undefined}
        >
          {t('notifications.markAllRead')}
        </Button>
      </div>
      <div className={styles.body} aria-busy={query.isPending || undefined}>
        {query.isPending ? (
          <>
            <SkeletonRow />
            <SkeletonRow />
            <SkeletonRow />
          </>
        ) : query.isError ? (
          <div className={styles.error}>
            <ErrorBanner
              error={query.error}
              title={t('notifications.loadError')}
              onRetry={() => void query.refetch()}
              retrying={query.isFetching}
            />
          </div>
        ) : items.length === 0 ? (
          <EmptyState icon={BellOff} message={t('notifications.empty')} />
        ) : (
          <ul className={styles.list}>
            {items.map((n) => {
              const kind = KIND_ICON[n.kind];
              const isUnread = n.readAt === null;
              return (
                <li key={n.id}>
                  <Link
                    href={hrefFor(n)}
                    className={cx(styles.item, isUnread && styles.unread)}
                    onClick={() => {
                      if (isUnread) markRead.mutate([n.id]);
                      onNavigate();
                    }}
                  >
                    <span className={cx(styles.kindIcon, kind.tone)}>
                      <Icon icon={kind.icon} size={16} />
                    </span>
                    <span className={styles.text}>
                      <span className={styles.message} dir="auto">
                        {message(n)}
                      </span>
                      <RelativeTime value={n.createdAt} className={styles.time} />
                    </span>
                    {isUnread && (
                      <span className={styles.dot}>
                        <span className="visually-hidden">{t('notifications.unread')}</span>
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
