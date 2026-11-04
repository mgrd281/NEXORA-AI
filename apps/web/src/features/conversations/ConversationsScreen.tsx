'use client';

import type { ConversationSummary } from '@jarvis/contracts';
import { isTerminal } from '@jarvis/contracts';
import { CalendarClock, MessagesSquare, Search, SearchX } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Page } from '@/components/shell/Page';
import { taskLine } from '@/components/tasks/TaskRow';
import { TaskStatusPill } from '@/components/tasks/TaskStatusPill';
import { ErrorBanner } from '@/components/ui/Banner';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { TextField } from '@/components/ui/Field';
import { Icon } from '@/components/ui/Icon';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { SkeletonRow } from '@/components/ui/Skeleton';
import { Spinner } from '@/components/ui/Spinner';
import { useComposerRegistry } from '@/components/composer/ComposerRegistry';
import { TaskCenterNav } from '@/features/tasks/TaskCenterNav';
import { useI18n } from '@/i18n/I18nProvider';
import { serverText } from '@/i18n/server-message';
import { useNow } from '@/lib/hooks/useNow';
import { useConversationList } from './api';
import styles from './Conversations.module.css';

const SEARCH_DEBOUNCE_MS = 300;

/**
 * Conversation history (Task Center › Conversations): every conversation, most recent activity
 * first, searchable by title and request. Each row opens its newest task, where the thread
 * shows the earlier requests above and the follow-up field below.
 */
export function ConversationsScreen({ initialQuery = '' }: { initialQuery?: string }) {
  const { t } = useI18n();
  const [query, setQuery] = useState(initialQuery);
  const [q, setQ] = useState(initialQuery.trim());

  useEffect(() => {
    const next = query.trim();
    const timer = window.setTimeout(() => setQ(next), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);
  // The search is part of the URL (shareable, survives reloads).
  useEffect(() => {
    const url = new URL(window.location.href);
    if (q) url.searchParams.set('q', q);
    else url.searchParams.delete('q');
    if (url.href !== window.location.href) window.history.replaceState(null, '', url);
  }, [q]);

  return (
    <Page title={t('tasks.title')} description={t('conversations.list.description')} width="wide">
      <TaskCenterNav current="conversations" />
      <div className={styles.search} role="search">
        <span className={styles.searchIcon} aria-hidden="true">
          <Icon icon={Search} size={16} />
        </span>
        <TextField
          type="search"
          label={t('conversations.list.searchLabel')}
          hideLabel
          placeholder={t('conversations.list.searchPlaceholder')}
          value={query}
          dir={query ? 'auto' : undefined}
          enterKeyHint="search"
          className={styles.searchInput}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') setQ(query.trim());
          }}
        />
      </div>
      <ConversationList q={q} onClear={() => setQuery('')} />
    </Page>
  );
}

function ConversationList({ q, onClear }: { q: string; onClear: () => void }) {
  const { t } = useI18n();
  const registry = useComposerRegistry();
  const list = useConversationList(q);
  const listRef = useRef<HTMLUListElement>(null);
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const [focusIndex, setFocusIndex] = useState<number | null>(null);

  useEffect(() => {
    if (focusIndex === null) return;
    const row = listRef.current?.children.item(focusIndex);
    if (row) {
      row.querySelector<HTMLAnchorElement>('a')?.focus();
      setFocusIndex(null);
    }
  }, [focusIndex, items.length]);

  if (list.isPending) {
    return (
      <Card padding="none">
        <div className={styles.skeleton} aria-busy="true">
          <span className="visually-hidden" role="status">
            {t('conversations.list.loading')}
          </span>
          {Array.from({ length: 4 }, (_, i) => (
            <SkeletonRow key={i} />
          ))}
        </div>
      </Card>
    );
  }
  if (list.isError && items.length === 0) {
    return (
      <ErrorBanner
        title={t('conversations.list.loadError')}
        error={list.error}
        onRetry={() => void list.refetch()}
        retrying={list.isRefetching}
      />
    );
  }
  if (items.length === 0) {
    return (
      <Card padding="none">
        {q ? (
          <EmptyState
            icon={SearchX}
            message={t('conversations.list.noResults', { query: q })}
            action={<Button onClick={onClear}>{t('conversations.list.clearSearch')}</Button>}
          />
        ) : (
          <EmptyState
            icon={MessagesSquare}
            message={t('conversations.list.empty')}
            action={
              <Button variant="primary" onClick={() => registry?.focusComposer()}>
                {t('tasks.emptyAction')}
              </Button>
            }
          />
        )}
      </Card>
    );
  }

  const loadMore = async () => {
    const before = items.length;
    const result = await list.fetchNextPage();
    if (!result.isError) setFocusIndex(before);
  };

  return (
    <div className={styles.listArea}>
      <Card padding="none">
        <ul ref={listRef} className={styles.list} aria-label={t('conversations.list.label')}>
          {items.map((c) => (
            <ConversationRow key={c.id} conversation={c} />
          ))}
        </ul>
      </Card>
      <div className={styles.footer}>
        <p className={styles.count} role="status" aria-live="polite">
          {list.isFetchingNextPage
            ? t('conversations.list.loadingMore')
            : list.hasNextPage
              ? t('conversations.list.shown', { count: items.length })
              : items.length > 5
                ? t('conversations.list.allShown')
                : ''}
        </p>
        {list.hasNextPage && (
          <Button onClick={() => void loadMore()} loading={list.isFetchingNextPage}>
            {t('common.actions.loadMore')}
          </Button>
        )}
      </div>
      {list.isFetchNextPageError && (
        <ErrorBanner
          title={t('conversations.list.loadMoreError')}
          error={list.error}
          onRetry={() => void loadMore()}
        />
      )}
    </div>
  );
}

function ConversationRow({ conversation: c }: { conversation: ConversationSummary }) {
  const i18n = useI18n();
  const { t, f } = i18n;
  const now = useNow();
  const title = serverText(i18n, c.titleMessage, c.title);
  const requests = t('conversations.list.requests', { count: c.taskCount });
  const updated = now === 0 ? f.dateTime(c.updatedAt) : f.relative(c.updatedAt, now);
  const last = c.lastTask;
  const href = last ? `/tasks/${last.id}` : null;
  const body = (
    <span className={styles.title} dir="auto">
      {title}
    </span>
  );
  return (
    <li className={styles.row}>
      <div className={styles.main}>
        {href ? (
          <Link
            href={href}
            className={styles.link}
            aria-label={t('conversations.list.accessibleName', { title, requests, time: updated })}
          >
            {body}
          </Link>
        ) : (
          body
        )}
        {last && (
          <span className={styles.line} dir="auto">
            {taskLine(i18n, last)}
          </span>
        )}
      </div>
      <div className={styles.meta}>
        {/* The newest task's real state (running, waiting for approval, needs an answer…). Only
            when an older run of a schedule is still active is it the generic "in progress". */}
        {last && !(c.hasActiveTask && isTerminal(last.status)) ? (
          <TaskStatusPill status={last.status} outcome={last.outcome} />
        ) : (
          c.hasActiveTask && (
            <span className={styles.active}>
              <Spinner size={16} />
              {t('conversations.list.active')}
            </span>
          )
        )}
        {c.scheduleId && (
          <Badge icon={CalendarClock} className={styles.scheduled}>
            {t('conversations.list.fromSchedule')}
          </Badge>
        )}
        <span className={styles.requests}>{requests}</span>
        <RelativeTime value={c.updatedAt} className={styles.time} />
      </div>
    </li>
  );
}
