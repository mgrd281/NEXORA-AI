'use client';

import type { TaskSummary } from '@jarvis/contracts';
import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { useI18n } from '@/i18n/I18nProvider';
import { useNow } from '@/lib/hooks/useNow';
import { cx } from '@/lib/cx';
import { TaskStatusPill } from './TaskStatusPill';
import styles from './TaskRow.module.css';

/** The one line under the title: the result, the error, or what was asked. */
export function taskLine(
  task: Pick<TaskSummary, 'status' | 'resultSummary' | 'error' | 'request'>,
): string {
  if (task.status === 'FAILED' && task.error) return task.error.message;
  return task.resultSummary ?? task.request;
}

/**
 * A task in a list (render inside a ListGroup-like `<ul>`): title, one line of result or
 * request, state chip, progress "n of m" while running, and updated time. The whole row links
 * to the task; `onReviewApproval` adds a Review button for a pending approval.
 */
export function TaskRow({
  task,
  href = `/tasks/${task.id}`,
  onReviewApproval,
  className,
}: {
  task: TaskSummary;
  href?: string;
  onReviewApproval?: (approvalId: string, task: TaskSummary) => void;
  className?: string;
}) {
  const { t, f } = useI18n();
  const now = useNow();
  const status = t(`common.taskStatus.${task.status}`);
  const updated = now === 0 ? f.dateTime(task.updatedAt) : f.relative(task.updatedAt, now);
  const showProgress = task.status === 'RUNNING' && task.progress.total > 0;
  const approvalId = task.pendingApprovalId;
  return (
    <li className={cx(styles.row, className)}>
      <div className={styles.main}>
        <Link
          href={href}
          className={styles.link}
          aria-label={t('tasks.row.accessibleName', { title: task.title, status, time: updated })}
        >
          {/* dir="auto" on the truncating element: the ellipsis falls at the end of the text's
              own direction, while text-align: match-parent keeps it on the list's start edge. */}
          <span className={styles.title} dir="auto">
            {task.title}
          </span>
        </Link>
        <span className={styles.line} dir="auto">
          {taskLine(task)}
        </span>
      </div>
      <div className={styles.meta}>
        <TaskStatusPill status={task.status} />
        {showProgress && (
          <span className={cx(styles.progress, 'tabular')}>
            <span aria-hidden="true">
              {t('tasks.row.progress', {
                completed: task.progress.completed,
                total: task.progress.total,
              })}
            </span>
            <span className="visually-hidden">
              {t('common.progressLabel', {
                completed: task.progress.completed,
                total: task.progress.total,
              })}
            </span>
          </span>
        )}
        {approvalId && onReviewApproval ? (
          <Button
            size="sm"
            variant="secondary"
            className={styles.review}
            onClick={() => onReviewApproval(approvalId, task)}
            aria-label={t('tasks.row.reviewLabel', { title: task.title })}
          >
            {t('tasks.row.review')}
          </Button>
        ) : (
          <RelativeTime value={task.updatedAt} className={styles.time} />
        )}
      </div>
    </li>
  );
}
