'use client';

import type { Schedule, ScheduleRun } from '@jarvis/contracts';
import { SCHEDULE_LIMITS } from '@jarvis/contracts';
import type { LucideIcon } from 'lucide-react';
import {
  CalendarClock,
  CalendarX,
  ChevronDown,
  CircleCheck,
  CirclePause,
  CirclePlay,
  Pencil,
  Plus,
  Trash,
} from 'lucide-react';
import Link from 'next/link';
import { useId, useState } from 'react';
import { Page } from '@/components/shell/Page';
import { taskTitle } from '@/components/tasks/TaskRow';
import { TaskStatusPill } from '@/components/tasks/TaskStatusPill';
import { StatusPill, type Tone } from '@/components/ui/Badge';
import { Banner, ErrorBanner } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Dialog } from '@/components/ui/Dialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { Skeleton, SkeletonRow } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { zoneDisplayName } from '@/features/settings/timeZones';
import { TaskCenterNav } from '@/features/tasks/TaskCenterNav';
import { useI18n } from '@/i18n/I18nProvider';
import { useMe } from '@/lib/api/hooks';
import { useDeleteSchedule, usePauseResume, useScheduleDetail, useSchedules } from './api';
import { describeRecurrence, formatInZone } from './recurrence';
import { ScheduleEditor } from './ScheduleEditor';
import styles from './Schedules.module.css';

const STATUS: Record<Schedule['status'], { tone: Tone; icon: LucideIcon }> = {
  active: { tone: 'success', icon: CircleCheck },
  paused: { tone: 'neutral', icon: CirclePause },
  completed: { tone: 'neutral', icon: CalendarX },
};

/**
 * Task Center › Scheduled: every schedule as a card — what it asks, how often (phrased from
 * its fields), the next run in its own time zone, the last run — with pause / resume, edit,
 * delete and the run history. Creating one opens the editor; nothing here pre-approves a run.
 */
export function ScheduledScreen() {
  const { t } = useI18n();
  const me = useMe();
  const schedules = useSchedules();
  const [editing, setEditing] = useState<Schedule | 'new' | null>(null);
  const items = schedules.data?.items ?? [];
  const open = items.filter((s) => s.status !== 'completed').length;
  const atLimit = open >= SCHEDULE_LIMITS.maxPerUser;
  const timeZone = me.data?.timeZone ?? 'UTC';

  return (
    <Page
      title={t('tasks.title')}
      description={t('schedules.description')}
      width="wide"
      actions={
        <Button
          variant="primary"
          icon={Plus}
          onClick={() => setEditing('new')}
          disabled={!me.data || atLimit}
        >
          {t('schedules.new')}
        </Button>
      }
    >
      <TaskCenterNav current="scheduled" />
      {schedules.isPending ? (
        <Card padding="none">
          <div className={styles.skeleton} aria-busy="true">
            <span className="visually-hidden" role="status">
              {t('schedules.loading')}
            </span>
            <SkeletonRow />
            <SkeletonRow />
          </div>
        </Card>
      ) : schedules.isError && !schedules.data ? (
        <ErrorBanner
          title={t('schedules.loadError')}
          error={schedules.error}
          onRetry={() => void schedules.refetch()}
          retrying={schedules.isFetching}
        />
      ) : items.length === 0 ? (
        <Card padding="none">
          <EmptyState
            icon={CalendarClock}
            message={t('schedules.empty')}
            action={
              <Button variant="primary" icon={Plus} onClick={() => setEditing('new')} disabled={!me.data}>
                {t('schedules.new')}
              </Button>
            }
          />
        </Card>
      ) : (
        <>
          {/* eslint-disable-next-line jsx-a11y/no-redundant-roles -- list-style: none drops it in Safari */}
          <ul className={styles.cards} role="list" aria-label={t('schedules.listLabel')}>
            {items.map((schedule) => (
              <li key={schedule.id}>
                <ScheduleCard schedule={schedule} onEdit={() => setEditing(schedule)} />
              </li>
            ))}
          </ul>
          <p className={styles.limit}>
            {t('schedules.limit', { count: open, max: SCHEDULE_LIMITS.maxPerUser })}
          </p>
        </>
      )}
      {editing !== null && (
        <ScheduleEditor
          schedule={editing === 'new' ? null : editing}
          defaultTimeZone={timeZone}
          onClose={() => setEditing(null)}
        />
      )}
    </Page>
  );
}

function pausedReason(t: ReturnType<typeof useI18n>['t'], schedule: Schedule): string | null {
  if (schedule.status === 'completed') return t('schedules.completedNote');
  if (schedule.status !== 'paused') return null;
  switch (schedule.pausedReason) {
    case 'failures':
      return t('schedules.pausedReason.failures', { count: SCHEDULE_LIMITS.failuresBeforePause });
    case 'budget':
      return t('schedules.pausedReason.budget');
    default:
      return t('schedules.pausedReason.user');
  }
}

function ScheduleCard({ schedule, onEdit }: { schedule: Schedule; onEdit: () => void }) {
  const i18n = useI18n();
  const { t, f } = i18n;
  const { toast } = useToast();
  const me = useMe();
  const titleId = useId();
  const historyId = useId();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const toggle = usePauseResume(schedule.id);
  const remove = useDeleteSchedule(schedule.id);
  const zone = schedule.recurrence.timeZone;
  const otherZone = me.data && me.data.timeZone !== zone;
  const status = STATUS[schedule.status];
  const reason = pausedReason(t, schedule);
  const warn = schedule.status === 'paused' && schedule.pausedReason !== 'user';
  const nextRun = schedule.nextRunAt ? formatInZone(schedule.nextRunAt, zone, f.intlLocale) : null;
  const titleText = schedule.title;

  return (
    <section className={styles.card} aria-labelledby={titleId}>
      <header className={styles.header}>
        <span className={styles.iconTile} aria-hidden="true">
          <Icon icon={CalendarClock} size={20} />
        </span>
        <div className={styles.titles}>
          <h2 id={titleId} className={styles.title}>
            <bdi>{titleText}</bdi>
          </h2>
          <p className={styles.summary}>{describeRecurrence(schedule.recurrence, i18n)}</p>
        </div>
        <div className={styles.status}>
          <StatusPill
            tone={warn ? 'warning' : status.tone}
            icon={status.icon}
            label={t(`schedules.status.${schedule.status}`)}
          />
        </div>
      </header>

      <div className={styles.body}>
        {reason && warn ? (
          <Banner tone="warning" title={reason} />
        ) : (
          reason && <p className={styles.note}>{reason}</p>
        )}
        <dl className={styles.facts}>
          <div>
            <dt>{t('schedules.next')}</dt>
            <dd className="tabular">
              {nextRun && schedule.nextRunAt ? (
                <time dateTime={schedule.nextRunAt}>
                  {otherZone
                    ? t('schedules.inZone', { time: nextRun, zone: zoneDisplayName(zone) })
                    : nextRun}
                </time>
              ) : (
                '—'
              )}
            </dd>
          </div>
          <div>
            <dt>{t('schedules.lastRun')}</dt>
            <dd>
              {schedule.lastRunAt ? (
                schedule.lastTaskId ? (
                  <Link href={`/tasks/${schedule.lastTaskId}`}>
                    <RelativeTime value={schedule.lastRunAt} />
                  </Link>
                ) : (
                  <RelativeTime value={schedule.lastRunAt} />
                )
              ) : (
                <span className={styles.muted}>{t('schedules.noRunsYet')}</span>
              )}
            </dd>
          </div>
        </dl>
        <figure className={styles.request}>
          <figcaption className={styles.requestLabel}>{t('schedules.request')}</figcaption>
          <blockquote className={styles.requestText} dir="auto">
            {schedule.request}
          </blockquote>
        </figure>
        {schedule.createdBy === 'agent' && (
          <p className={styles.note}>{t('schedules.createdByAgent')}</p>
        )}
        {(toggle.isError || remove.isError) && <ErrorBanner error={toggle.error ?? remove.error} />}
        {historyOpen && (
          <div id={historyId}>
            <RunHistory schedule={schedule} />
          </div>
        )}
      </div>

      <footer className={styles.footer}>
        <button
          type="button"
          className={styles.historyToggle}
          aria-expanded={historyOpen}
          aria-controls={historyOpen ? historyId : undefined}
          onClick={() => setHistoryOpen((v) => !v)}
        >
          <span className="tabular">{t('schedules.runCount', { count: schedule.runCount })}</span>
          <span aria-hidden="true">·</span>
          <span>
            {historyOpen ? t('schedules.actions.hideHistory') : t('schedules.actions.history')}
          </span>
          <Icon icon={ChevronDown} size={16} className={styles.chevron} />
        </button>
        <div className={styles.actions}>
          {schedule.status !== 'completed' && (
            <Button
              size="sm"
              icon={schedule.status === 'paused' ? CirclePlay : CirclePause}
              loading={toggle.isPending}
              aria-label={t('schedules.actionFor', {
                action:
                  schedule.status === 'paused'
                    ? t('schedules.actions.resume')
                    : t('schedules.actions.pause'),
                title: titleText,
              })}
              onClick={() => {
                const action = schedule.status === 'paused' ? 'resume' : 'pause';
                toggle.mutate(action, {
                  onSuccess: () =>
                    toast({
                      message:
                        action === 'pause'
                          ? t('schedules.toasts.paused')
                          : t('schedules.toasts.resumed'),
                    }),
                });
              }}
            >
              {schedule.status === 'paused'
                ? t('schedules.actions.resume')
                : t('schedules.actions.pause')}
            </Button>
          )}
          <Button
            size="sm"
            icon={Pencil}
            onClick={onEdit}
            aria-label={t('schedules.actionFor', { action: t('schedules.actions.edit'), title: titleText })}
          >
            {t('schedules.actions.edit')}
          </Button>
          <Button
            size="sm"
            variant="danger"
            icon={Trash}
            onClick={() => setConfirmDelete(true)}
            aria-label={t('schedules.actionFor', { action: t('schedules.actions.delete'), title: titleText })}
          >
            {t('schedules.actions.delete')}
          </Button>
        </div>
      </footer>

      <Dialog
        open={confirmDelete}
        onClose={() => {
          if (!remove.isPending) setConfirmDelete(false);
        }}
        title={t('schedules.deleteDialog.title')}
        description={t('schedules.deleteDialog.body', { title: titleText })}
        dismissible={!remove.isPending}
        busy={remove.isPending}
        footer={
          <>
            <Button onClick={() => setConfirmDelete(false)} disabled={remove.isPending}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="destructive"
              loading={remove.isPending}
              onClick={() =>
                remove.mutate(undefined, {
                  onSuccess: () => {
                    setConfirmDelete(false);
                    toast({ message: t('schedules.toasts.deleted') });
                  },
                })
              }
            >
              {t('schedules.deleteDialog.confirm')}
            </Button>
          </>
        }
      >
        {remove.isError && <ErrorBanner error={remove.error} />}
      </Dialog>
    </section>
  );
}

/** Upcoming occurrences and the recent runs (each linking to the task it created). */
function RunHistory({ schedule }: { schedule: Schedule }) {
  const i18n = useI18n();
  const { t, f } = i18n;
  const detail = useScheduleDetail(schedule.id, true);
  const zone = schedule.recurrence.timeZone;
  if (detail.isPending) {
    return (
      <div className={styles.history} aria-busy="true">
        <span className="visually-hidden" role="status">
          {t('schedules.history.loading')}
        </span>
        <Skeleton width="40%" height={14} />
        <Skeleton width="70%" height={14} />
      </div>
    );
  }
  if (detail.isError) {
    return (
      <ErrorBanner
        title={t('schedules.history.loadError')}
        error={detail.error}
        onRetry={() => void detail.refetch()}
        retrying={detail.isFetching}
      />
    );
  }
  const { upcoming, runs } = detail.data;
  return (
    <div className={styles.history}>
      <div className={styles.historyBlock}>
        <h3 className={styles.historyTitle}>{t('schedules.history.upcoming')}</h3>
        {upcoming.length === 0 ? (
          <p className={styles.muted}>{t('schedules.history.upcomingNone')}</p>
        ) : (
          <ol className={styles.upcoming}>
            {upcoming.map((at) => (
              <li key={at} className="tabular">
                <time dateTime={at}>{formatInZone(at, zone, f.intlLocale)}</time>
              </li>
            ))}
          </ol>
        )}
      </div>
      <div className={styles.historyBlock}>
        <h3 className={styles.historyTitle}>{t('schedules.history.recent')}</h3>
        {runs.length === 0 ? (
          <p className={styles.muted}>{t('schedules.history.recentNone')}</p>
        ) : (
          <ol className={styles.runs}>
            {runs.map((run) => (
              <RunRow key={run.id} run={run} zone={zone} />
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

function RunRow({ run, zone }: { run: ScheduleRun; zone: string }) {
  const i18n = useI18n();
  const { t, f } = i18n;
  return (
    <li className={styles.run}>
      <time dateTime={run.occurrenceAt} className={styles.runTime}>
        {formatInZone(run.occurrenceAt, zone, f.intlLocale)}
      </time>
      {run.task ? (
        <span className={styles.runTask}>
          <TaskStatusPill status={run.task.status} outcome={run.task.outcome} />
          <Link href={`/tasks/${run.task.id}`} className={styles.runLink}>
            <span dir="auto">{taskTitle(i18n, run.task)}</span>
          </Link>
        </span>
      ) : (
        <span className={styles.runTask}>
          <StatusPill
            tone={run.status === 'failed' ? 'danger' : 'neutral'}
            icon={run.status === 'failed' ? CalendarX : CirclePause}
            label={t(`schedules.history.run.${run.status}`)}
          />
          <span className={styles.muted}>
            {run.reason
              ? t(`schedules.history.reasons.${run.reason}`)
              : run.status === 'created'
                ? t('schedules.history.taskGone')
                : null}
          </span>
        </span>
      )}
    </li>
  );
}

