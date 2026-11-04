'use client';

import type { Notification } from '@jarvis/contracts';
import type { LucideIcon } from 'lucide-react';
import {
  BellOff,
  CalendarX,
  CircleAlert,
  CircleCheck,
  CirclePause,
  Hand,
  PlugZap,
  Webhook,
} from 'lucide-react';
import Link from 'next/link';
import { ErrorBanner } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { SkeletonRow } from '@/components/ui/Skeleton';
import { useI18n } from '@/i18n/I18nProvider';
import type { TranslateFn } from '@/i18n/translate';
import { useMarkNotificationsRead, useNotifications } from '@/lib/api/hooks';
import { cx } from '@/lib/cx';
import styles from './NotificationsPanel.module.css';

const KIND_ICON: Record<Notification['kind'], { icon: LucideIcon; tone: string }> = {
  approval_requested: { icon: Hand, tone: styles.warning ?? '' },
  task_completed: { icon: CircleCheck, tone: styles.success ?? '' },
  task_failed: { icon: CircleAlert, tone: styles.danger ?? '' },
  connection_error: { icon: PlugZap, tone: styles.danger ?? '' },
  schedule_failed: { icon: CalendarX, tone: styles.danger ?? '' },
  schedule_paused: { icon: CirclePause, tone: styles.warning ?? '' },
  webhook_disabled: { icon: Webhook, tone: styles.danger ?? '' },
};

function hrefFor(n: Notification): string {
  if (n.kind === 'connection_error') return '/connections';
  if (n.kind === 'webhook_disabled') return '/connections#developer';
  if (n.kind === 'schedule_paused') return '/tasks/scheduled';
  if (n.kind === 'schedule_failed' && !n.taskId) return '/tasks/scheduled';
  return n.taskId ? `/tasks/${n.taskId}` : '/tasks';
}

/** The notification in the interface language; data carries only the parameters. */
function notificationMessage(t: TranslateFn, n: Notification): string {
  const d = n.data;
  switch (n.kind) {
    case 'schedule_failed':
      return d.scheduleTitle
        ? t('notifications.kinds.schedule_failed', { scheduleTitle: d.scheduleTitle })
        : t('notifications.kindsUntitled.schedule_failed');
    case 'schedule_paused':
      return d.scheduleTitle
        ? t('notifications.kinds.schedule_paused', {
            scheduleTitle: d.scheduleTitle,
            reason: d.reason === 'budget' ? 'budget' : 'failures',
          })
        : t('notifications.kindsUntitled.schedule_paused');
    case 'webhook_disabled':
      return d.endpointHost
        ? t('notifications.kinds.webhook_disabled', { endpointHost: d.endpointHost })
        : t('notifications.kindsUntitled.webhook_disabled');
    case 'approval_requested':
    case 'task_completed':
    case 'task_failed':
    case 'connection_error':
      return d.taskTitle
        ? t(`notifications.kinds.${n.kind}`, { taskTitle: d.taskTitle })
        : t(`notifications.kindsUntitled.${n.kind}`);
  }
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

  const message = (n: Notification) => notificationMessage(t, n);

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
                      {/* A sentence in the interface language; t() isolates the task title. */}
                      <span className={styles.message}>{message(n)}</span>
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
