'use client';

import type { EmailWatch } from '@jarvis/contracts';
import { EMAIL_LIMITS } from '@jarvis/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { LucideIcon } from 'lucide-react';
import { BellRing, CircleAlert, CircleDashed, MailCheck, TimerOff } from 'lucide-react';
import Link from 'next/link';
import { useId } from 'react';
import { ErrorBanner } from '@/components/ui/Banner';
import { StatusPill, type Tone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { Skeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { UserText } from '@/components/ui/UserText';
import { useI18n } from '@/i18n/I18nProvider';
import { PROVIDER_NAME } from '@/i18n/server-message';
import { api, type ApiError } from '@/lib/api/client';
import { qk } from '@/lib/api/query-keys';
import { SettingRow, SettingsCard } from './controls';
import { SettingsSection } from './SettingsSection';
import styles from './settings.module.css';

export function useEmailWatches() {
  return useQuery({
    queryKey: qk.emailWatches,
    queryFn: ({ signal }) => api.call('listEmailWatches', { signal }),
  });
}

const STATUS: Record<EmailWatch['status'], { tone: Tone; icon: LucideIcon }> = {
  watching: { tone: 'accent', icon: BellRing },
  replied: { tone: 'success', icon: MailCheck },
  stopped: { tone: 'neutral', icon: CircleDashed },
  expired: { tone: 'neutral', icon: TimerOff },
  failed: { tone: 'danger', icon: CircleAlert },
};

/**
 * Settings › Reply tracking: the email threads JARVIS watches for replies (email.track_replies),
 * with when it checks next and until when, who replied, and Stop. Only subjects and senders are
 * kept — never the messages.
 */
export function RepliesSection() {
  const { t } = useI18n();
  const watches = useEmailWatches();
  const items = watches.data?.items ?? [];
  const titleId = useId();
  return (
    <SettingsSection
      id="replies"
      title={t('settings.sections.replies')}
      description={t('settings.replies.description', { minutes: EMAIL_LIMITS.watchPollMinutes })}
    >
      <SettingsCard>
        <SettingRow>
          <h3 id={titleId} className="visually-hidden">
            {t('settings.sections.replies')}
          </h3>
          {watches.isPending ? (
            <div className={styles.skeletonBody} aria-busy="true">
              <span className="visually-hidden" role="status">
                {t('common.status.loading')}
              </span>
              <Skeleton width="60%" height={16} />
              <Skeleton width="40%" height={12} />
            </div>
          ) : watches.isError && !watches.data ? (
            <ErrorBanner error={watches.error} onRetry={() => void watches.refetch()} />
          ) : items.length === 0 ? (
            <p className={styles.rowText}>{t('settings.replies.empty')}</p>
          ) : (
            <ul className={styles.records} aria-labelledby={titleId}>
              {items.map((w) => (
                <WatchItem key={w.id} watch={w} />
              ))}
            </ul>
          )}
        </SettingRow>
      </SettingsCard>
    </SettingsSection>
  );
}

function WatchItem({ watch }: { watch: EmailWatch }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const s = STATUS[watch.status];
  const stop = useMutation<void, ApiError>({
    mutationFn: () => api.call('deleteEmailWatch', { params: { id: watch.id } }),
    onSuccess: () => {
      queryClient.setQueryData<{ items: EmailWatch[] }>(qk.emailWatches, (prev) =>
        prev
          ? {
              items: prev.items.map((w) =>
                w.id === watch.id ? { ...w, status: 'stopped', nextCheckAt: null } : w,
              ),
            }
          : prev,
      );
      void queryClient.invalidateQueries({ queryKey: qk.emailWatches });
      toast({ message: t('settings.replies.stopped') });
    },
  });
  return (
    <li className={styles.record}>
      <span className={styles.recordIcon} aria-hidden="true">
        <Icon icon={s.icon} size={20} />
      </span>
      <div className={styles.recordMain}>
        <p className={styles.recordTitle}>
          <UserText>{watch.subject || t('approvals.fields.noSubject')}</UserText>
        </p>
        <p className={styles.note}>
          {PROVIDER_NAME[watch.provider]}
          {' · '}
          <WatchLine watch={watch} />
        </p>
        {watch.taskId && (
          <Link href={`/tasks/${watch.taskId}`} className={styles.recordLink}>
            {t('settings.spending.openTask')}
          </Link>
        )}
        {stop.isError && <ErrorBanner error={stop.error} />}
      </div>
      <div className={styles.recordEnd}>
        <StatusPill
          tone={s.tone}
          icon={s.icon}
          label={t(`settings.replies.status.${watch.status}`)}
        />
        {watch.status === 'watching' && (
          <Button
            size="sm"
            variant="danger"
            loading={stop.isPending}
            onClick={() => stop.mutate()}
            aria-label={t('settings.replies.stopLabel', { subject: watch.subject })}
          >
            {t('settings.replies.stop')}
          </Button>
        )}
      </div>
    </li>
  );
}

function WatchLine({ watch }: { watch: EmailWatch }) {
  const { t } = useI18n();
  switch (watch.status) {
    case 'watching':
      return (
        <RelativeTime
          value={watch.expiresAt}
          format={(time) => t('settings.replies.until', { time })}
        />
      );
    case 'replied':
      return watch.replyAt ? (
        <RelativeTime
          value={watch.replyAt}
          format={(time) =>
            t('settings.replies.repliedBy', {
              name: watch.replyFrom?.name ?? watch.replyFrom?.address ?? '—',
              time,
            })
          }
        />
      ) : (
        <>{t('settings.replies.status.replied')}</>
      );
    case 'expired':
      return (
        <RelativeTime
          value={watch.expiresAt}
          format={(time) => t('settings.replies.expired', { time })}
        />
      );
    case 'failed':
      return <>{t('settings.replies.failed')}</>;
    case 'stopped':
      return <>{t('settings.replies.stoppedLine')}</>;
  }
}
