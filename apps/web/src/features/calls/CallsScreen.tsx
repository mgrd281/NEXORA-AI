'use client';

import type { CallSummary } from '@jarvis/contracts';
import { Phone } from 'lucide-react';
import Link from 'next/link';
import { Page } from '@/components/shell/Page';
import { StatusPill } from '@/components/ui/Badge';
import { ErrorBanner } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { SkeletonRow } from '@/components/ui/Skeleton';
import { LANGUAGE_NAMES } from '@/i18n/config';
import { useI18n } from '@/i18n/I18nProvider';
import { errorReason, serverText } from '@/i18n/server-message';
import { TaskCenterNav } from '@/features/tasks/TaskCenterNav';
import { useCalls } from './api';
import { callIcon } from './icons';
import { calleeLabel, callPill } from './model';
import styles from './Calls.module.css';

/**
 * Task Center › Calls: every call JARVIS placed or tried to place, newest first — who, the
 * number, how it ended (or where it is), when, how long — each opening its task (the call card
 * with what was said and the evidence).
 */
export function CallsScreen() {
  const { t } = useI18n();
  const calls = useCalls();
  const items = calls.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <Page title={t('tasks.title')} description={t('calls.description')} width="wide">
      <TaskCenterNav current="calls" />
      {calls.isPending ? (
        <Card padding="none">
          <div aria-busy="true">
            <span className="visually-hidden" role="status">
              {t('common.status.loading')}
            </span>
            <SkeletonRow />
            <SkeletonRow />
          </div>
        </Card>
      ) : calls.isError && !calls.data ? (
        <ErrorBanner
          title={t('calls.loadError')}
          error={calls.error}
          onRetry={() => void calls.refetch()}
          retrying={calls.isFetching}
        />
      ) : items.length === 0 ? (
        <Card padding="none">
          <EmptyState icon={Phone} message={t('calls.empty')} />
        </Card>
      ) : (
        <Card padding="none">
          {/* eslint-disable-next-line jsx-a11y/no-redundant-roles -- list-style: none drops it in Safari */}
          <ul className={styles.list} role="list" aria-label={t('calls.title')}>
            {items.map((call) => (
              <li key={call.id}>
                <CallRow call={call} />
              </li>
            ))}
          </ul>
          {calls.hasNextPage && (
            <div className={styles.more}>
              <Button onClick={() => void calls.fetchNextPage()} loading={calls.isFetchingNextPage}>
                {t('calls.loadMore')}
              </Button>
            </div>
          )}
        </Card>
      )}
    </Page>
  );
}

function CallRow({ call }: { call: CallSummary }) {
  const i18n = useI18n();
  const { t, f } = i18n;
  const pill = callPill(call);
  const reason = call.failureReason ? errorReason(i18n, { reason: call.failureReason }) : null;
  // The task this call belongs to (older servers send no title).
  const task =
    call.taskTitle !== undefined
      ? serverText(i18n, call.taskTitleMessage ?? null, call.taskTitle)
      : null;
  return (
    <Link href={`/tasks/${call.taskId}`} className={styles.row}>
      <span className={styles.headIcon} aria-hidden="true">
        <Icon icon={Phone} size={20} />
      </span>
      <span className={styles.rowText}>
        {/* The name as the user wrote it: its own direction, truncating at its own end. */}
        <span className={styles.rowTitle} dir="auto">
          {calleeLabel(call)}
        </span>
        <span className={styles.rowMeta}>
          <span className="ltr tabular">{call.toDisplay}</span>
          <span lang={call.language}>{LANGUAGE_NAMES[call.language]}</span>
          <RelativeTime value={call.endedAt ?? call.createdAt} />
          {call.durationSeconds !== null && call.durationSeconds > 0 && (
            <span className="tabular">{f.duration(call.durationSeconds * 1000)}</span>
          )}
          {call.attempt > 1 && <span>{t('calls.card.attempt', { n: call.attempt })}</span>}
        </span>
        {task && (
          <span className={styles.rowMeta} dir="auto">
            {task}
          </span>
        )}
        {reason && <span className={styles.rowMeta}>{reason}</span>}
      </span>
      <StatusPill tone={pill.tone} icon={callIcon(call)} label={t(pill.key)} />
    </Link>
  );
}
