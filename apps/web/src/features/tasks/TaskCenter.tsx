'use client';

import type { Approval, TaskSummary } from '@jarvis/contracts';
import { ListChecks } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApprovalSheet } from '@/components/approvals/ApprovalSheet';
import { useComposerRegistry } from '@/components/composer/ComposerRegistry';
import { Page } from '@/components/shell/Page';
import { TaskRow } from '@/components/tasks/TaskRow';
import { ErrorBanner } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { SkeletonRow } from '@/components/ui/Skeleton';
import { useI18n } from '@/i18n/I18nProvider';
import { useApprovals } from '@/lib/api/hooks';
import { useTaskList } from './api';
import {
  FILTER_EMPTY,
  FILTER_LABEL,
  filterHref,
  parseFilter,
  TASK_FILTERS,
  type TaskFilter,
} from './model';
import styles from './TaskCenter.module.css';

/**
 * Task Center: every task, filtered by status (synced to ?status=), paged by cursor, kept live
 * by the event stream (task events invalidate the lists).
 */
export function TaskCenter() {
  const { t } = useI18n();
  const searchParams = useSearchParams();
  const filter = parseFilter(searchParams.get('status'));

  const setFilter = useCallback((next: TaskFilter) => {
    // Shallow URL update (the App Router syncs useSearchParams without a server round trip).
    // A new history entry: the filtered list is shareable and Back returns to the previous one.
    window.history.pushState(null, '', filterHref(next));
  }, []);

  // Keep the selected filter in view inside the scrolling filter row (phones).
  const filterBar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const bar = filterBar.current;
    const checked = bar?.querySelector<HTMLElement>('label[data-checked]');
    if (!bar || !checked) return;
    const barBox = bar.getBoundingClientRect();
    const box = checked.getBoundingClientRect();
    if (box.left < barBox.left || box.right > barBox.right) {
      bar.scrollBy({ left: box.left - barBox.left - (barBox.width - box.width) / 2 });
    }
  }, [filter]);

  // While options lie past the trailing edge, the row fades out there ("scroll for more").
  useEffect(() => {
    const bar = filterBar.current;
    if (!bar || typeof ResizeObserver === 'undefined') return;
    const update = () => {
      // scrollLeft runs negative in right-to-left layouts.
      const rest = bar.scrollWidth - bar.clientWidth - Math.abs(bar.scrollLeft);
      bar.toggleAttribute('data-more-end', rest > 1);
    };
    const observer = new ResizeObserver(update);
    observer.observe(bar);
    bar.addEventListener('scroll', update, { passive: true });
    return () => {
      observer.disconnect();
      bar.removeEventListener('scroll', update);
    };
  }, []);

  return (
    <Page title={t('tasks.title')} description={t('tasks.description')} width="wide">
      <div className={styles.filterBar} ref={filterBar}>
        <SegmentedControl
          legend={t('tasks.filters.legend')}
          options={TASK_FILTERS.map((value) => ({ value, label: t(FILTER_LABEL[value]) }))}
          value={filter}
          onChange={setFilter}
          name="task-filter"
        />
      </div>
      {/* Keyed by filter: each filter keeps its own pages and scroll-free reset. */}
      <TaskList key={filter} filter={filter} />
    </Page>
  );
}

function TaskList({ filter }: { filter: TaskFilter }) {
  const { t } = useI18n();
  const router = useRouter();
  const registry = useComposerRegistry();
  const list = useTaskList(filter);
  const approvals = useApprovals();
  const [reviewing, setReviewing] = useState<Approval | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const decidedTask = useRef<string | null>(null);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);

  const tasks = list.data?.pages.flatMap((p) => p.items) ?? [];

  // After a decision, the Review button disappears once the list refreshes: focus the task.
  useEffect(() => {
    const taskId = decidedTask.current;
    if (!taskId || !list.data) return;
    const row = list.data.pages.flatMap((p) => p.items).find((t) => t.id === taskId);
    if (row?.pendingApprovalId) return;
    decidedTask.current = null;
    const link = listRef.current?.querySelector<HTMLElement>(`a[href="/tasks/${taskId}"]`);
    (link ?? listRef.current?.querySelector<HTMLElement>('a'))?.focus();
  }, [list.data]);
  const filterName = t(FILTER_LABEL[filter]);

  const onReview = (approvalId: string, task: TaskSummary) => {
    const approval = approvals.data?.items.find((a) => a.id === approvalId);
    // Not in the pending list (yet): the task screen shows the approval with full context.
    if (approval) setReviewing(approval);
    else router.push(`/tasks/${task.id}`);
  };

  const loadMore = async () => {
    const before = tasks.length;
    const result = await list.fetchNextPage();
    if (!result.isError) setFocusIndex(before);
  };

  // After "Load more", move focus to the first newly loaded task (keyboard and screen readers).
  useEffect(() => {
    if (focusIndex === null) return;
    const row = listRef.current?.children.item(focusIndex);
    if (row) {
      row.querySelector<HTMLAnchorElement>('a')?.focus();
      setFocusIndex(null);
    }
  }, [focusIndex, tasks.length]);

  if (list.isPending) {
    return (
      <Card padding="none">
        <div className={styles.skeleton} aria-busy="true">
          <span className="visually-hidden" role="status">
            {t('tasks.list.loading')}
          </span>
          {Array.from({ length: 5 }, (_, i) => (
            <SkeletonRow key={i} />
          ))}
        </div>
      </Card>
    );
  }

  if (list.isError && tasks.length === 0) {
    return (
      <ErrorBanner
        title={t('tasks.list.loadError')}
        error={list.error}
        onRetry={() => void list.refetch()}
        retrying={list.isRefetching}
      />
    );
  }

  if (tasks.length === 0) {
    return (
      <Card padding="none">
        <EmptyState
          icon={ListChecks}
          message={t(FILTER_EMPTY[filter])}
          action={
            filter === 'all' ? (
              <Button variant="primary" onClick={() => registry?.focusComposer()}>
                {t('tasks.emptyAction')}
              </Button>
            ) : undefined
          }
        />
      </Card>
    );
  }

  return (
    <div className={styles.listArea}>
      <Card padding="none">
        <ul
          ref={listRef}
          className={styles.list}
          aria-label={t('tasks.list.label', { filter: filterName })}
        >
          {tasks.map((task) => (
            <TaskRow key={task.id} task={task} onReviewApproval={onReview} />
          ))}
        </ul>
      </Card>

      <div className={styles.footer}>
        <p className={styles.count} role="status" aria-live="polite">
          {list.isFetchingNextPage
            ? t('tasks.list.loadingMore')
            : list.hasNextPage
              ? t('tasks.list.shown', { count: tasks.length })
              : tasks.length > 5
                ? t('tasks.list.allShown')
                : ''}
        </p>
        {list.hasNextPage && (
          <Button onClick={() => void loadMore()} loading={list.isFetchingNextPage}>
            {t('common.actions.loadMore')}
          </Button>
        )}
      </div>
      {list.isRefetchError && (
        <ErrorBanner
          title={t('tasks.list.refreshError')}
          error={list.error}
          onRetry={() => void list.refetch()}
          retrying={list.isRefetching}
        />
      )}
      {list.isFetchNextPageError && (
        <ErrorBanner
          title={t('tasks.list.loadMoreError')}
          error={list.error}
          onRetry={() => void loadMore()}
        />
      )}

      <ApprovalSheet
        approval={reviewing}
        open={reviewing !== null}
        onClose={() => setReviewing(null)}
        onDecided={(a) => {
          decidedTask.current = a.taskId;
        }}
      />
    </div>
  );
}
