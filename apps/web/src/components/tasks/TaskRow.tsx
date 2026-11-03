'use client';

import type { TaskSummary } from '@jarvis/contracts';
import { TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { StatusPill } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { useI18n } from '@/i18n/I18nProvider';
import { errorLine, serverText, type ServerTextI18n } from '@/i18n/server-message';
import { useNow } from '@/lib/hooks/useNow';
import { cx } from '@/lib/cx';
import { TaskStatusPill } from './TaskStatusPill';
import styles from './TaskRow.module.css';

/**
 * The one line under the title, in the viewer's language where the server wrote it: what went
 * wrong (the error's reason, else its code's title — never the English developer message), the
 * result, or what was asked. `localized` lines are interface copy; the others are user, page or
 * model text in the request's language.
 */
export function taskLine(
  i18n: ServerTextI18n,
  task: Pick<
    TaskSummary,
    'status' | 'resultSummary' | 'resultSummaryMessage' | 'error' | 'request'
  >,
): string {
  if (task.status === 'FAILED' && task.error) return errorLine(i18n, task.error);
  if (task.resultSummary !== null || task.resultSummaryMessage)
    return serverText(i18n, task.resultSummaryMessage, task.resultSummary ?? task.request);
  return task.request;
}

/** The task's title in the viewer's language when the server wrote it (offline planner). */
export function taskTitle(
  i18n: ServerTextI18n,
  task: Pick<TaskSummary, 'title' | 'titleMessage'>,
): string {
  return serverText(i18n, task.titleMessage, task.title);
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
  const i18n = useI18n();
  const { t, f } = i18n;
  const now = useNow();
  const title = taskTitle(i18n, task);
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
          aria-label={t('tasks.row.accessibleName', { title, status, time: updated })}
        >
          {/* dir="auto" on the truncating element: the ellipsis falls at the end of the text's
              own direction, while text-align: match-parent keeps it on the list's start edge. */}
          <span className={styles.title} dir="auto">
            {title}
          </span>
        </Link>
        <span className={styles.line} dir="auto">
          {taskLine(i18n, task)}
        </span>
      </div>
      <div className={styles.meta}>
        <TaskStatusPill status={task.status} />
        {/* The waiting decision acts on content flagged as instructions aimed at AI. */}
        {task.pendingApproval?.untrustedSource && (
          <StatusPill tone="warning" icon={TriangleAlert} label={t('approvals.untrusted.chip')} />
        )}
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
            aria-label={t('tasks.row.reviewLabel', { title })}
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
