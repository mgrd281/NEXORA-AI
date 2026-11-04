'use client';

import { Brain, Search, SearchX } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { Page } from '@/components/shell/Page';
import { Banner, ErrorBanner } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { TextField } from '@/components/ui/Field';
import { Icon } from '@/components/ui/Icon';
import { Skeleton, SkeletonRow } from '@/components/ui/Skeleton';
import { PreferenceSwitch, SettingRow, SettingsCard } from '@/features/settings/controls';
import { RetentionSelect, retentionPeriod } from '@/features/settings/RetentionControls';
import { useI18n } from '@/i18n/I18nProvider';
import { useMe } from '@/lib/api/hooks';
import { cx } from '@/lib/cx';
import { AddMemoryForm } from './AddMemoryForm';
import { useMemories } from './api';
import { DeleteAllMemories } from './DeleteAllMemories';
import { MemoryItem } from './MemoryItem';
import styles from './memory.module.css';

const SEARCH_DEBOUNCE_MS = 300;

export function MemoryScreen({ initialQuery = '' }: { initialQuery?: string }) {
  const { t } = useI18n();
  const me = useMe();
  const memoryEnabled = me.data?.preferences.memory.enabled;

  return (
    <Page title={t('memory.title')} description={t('memory.description')}>
      {me.data ? (
        <SettingsCard>
          <PreferenceSwitch
            me={me.data}
            label={t('memory.toggle.label')}
            description={t('memory.toggle.description')}
            read={(m) => m.preferences.memory.enabled}
            write={(v) => ({ preferences: { memory: { enabled: v } } })}
          />
          <SettingRow>
            <RetentionSelect me={me.data} field="memoryDays" />
            {me.data.preferences.retention.memoryDays !== null && (
              <p className={styles.retentionRule}>
                {t('memory.retentionRule', {
                  period: retentionPeriod(t, me.data.preferences.retention.memoryDays),
                })}
              </p>
            )}
          </SettingRow>
        </SettingsCard>
      ) : me.isError ? (
        <ErrorBanner error={me.error} onRetry={() => void me.refetch()} retrying={me.isFetching} />
      ) : (
        <div className={styles.toggleSkeleton} aria-hidden="true">
          <Skeleton width="30%" height={16} />
          <Skeleton width="80%" height={12} />
        </div>
      )}
      {memoryEnabled === false && (
        <Banner tone="info" live title={t('memory.disabled')}>
          {t('memory.disabledBanner')}
        </Banner>
      )}
      <AddMemoryForm />
      <MemoryList initialQuery={initialQuery} />
    </Page>
  );
}

function MemoryList({ initialQuery }: { initialQuery: string }) {
  const { t } = useI18n();
  const titleId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [query, setQuery] = useState(initialQuery);
  const [q, setQ] = useState(initialQuery.trim());

  // Debounce typing, then mirror the search into ?q= (shareable, survives reloads).
  useEffect(() => {
    const next = query.trim();
    const timer = window.setTimeout(() => setQ(next), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    const url = new URL(window.location.href);
    if (q) url.searchParams.set('q', q);
    else url.searchParams.delete('q');
    if (url.href !== window.location.href) window.history.replaceState(null, '', url);
  }, [q]);

  const memories = useMemories(q);
  const items = memories.data?.pages.flatMap((p) => p.items) ?? [];
  const searching = q.length > 0;
  // Results shown for an older search while the new one loads.
  const stale = memories.isPlaceholderData;
  // Set by a deletion; the heading is focused after the commit that removed the row/dialog.
  const focusPending = useRef(false);
  const focusList = () => {
    focusPending.current = true;
    // Works at once when no dialog is open; otherwise the effect below finishes the job.
    headingRef.current?.focus();
  };
  useEffect(() => {
    if (!focusPending.current) return;
    focusPending.current = false;
    headingRef.current?.focus();
  });

  let body;
  if (memories.isPending) {
    body = (
      <Card padding="none">
        <div aria-busy="true">
          <span className="visually-hidden" role="status">
            {t('memory.list.loading')}
          </span>
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
        </div>
      </Card>
    );
  } else if (memories.isError && items.length === 0) {
    body = (
      <ErrorBanner
        error={memories.error}
        onRetry={() => void memories.refetch()}
        retrying={memories.isFetching}
      />
    );
  } else if (items.length === 0) {
    body = (
      <Card padding="none">
        {searching ? (
          <EmptyState
            icon={SearchX}
            message={t('memory.list.noResults', { query: q })}
            action={
              <Button size="sm" onClick={() => setQuery('')}>
                {t('memory.list.clearSearch')}
              </Button>
            }
          />
        ) : (
          <EmptyState icon={Brain} message={t('memory.list.emptyFull')} />
        )}
      </Card>
    );
  } else {
    body = (
      <>
        <Card padding="none">
          <ul
            className={cx(styles.list, stale && styles.stale)}
            aria-labelledby={titleId}
            aria-busy={stale || undefined}
          >
            {items.map((m) => (
              <MemoryItem key={m.id} memory={m} onDeleted={focusList} />
            ))}
          </ul>
        </Card>
        {memories.isError && (
          <ErrorBanner
            error={memories.error}
            onRetry={() => void memories.fetchNextPage()}
            retrying={memories.isFetchingNextPage}
          />
        )}
        {memories.hasNextPage && (
          <div className={styles.more}>
            <Button
              onClick={() => void memories.fetchNextPage()}
              loading={memories.isFetchingNextPage}
            >
              {t('memory.list.loadMore')}
            </Button>
          </div>
        )}
      </>
    );
  }

  const announcement =
    searching && !memories.isFetching && !memories.isError
      ? memories.hasNextPage
        ? t('memory.search.resultsMore', { count: items.length })
        : t('memory.search.results', { count: items.length })
      : '';

  const isEmptyAccount =
    !searching && !memories.isPending && !memories.isError && items.length === 0;

  return (
    <>
      <section className={styles.listSection} aria-labelledby={titleId}>
        <div className={styles.listHeader}>
          <h2 id={titleId} ref={headingRef} tabIndex={-1} className={styles.listTitle}>
            {t('memory.list.title')}
          </h2>
          {!isEmptyAccount && (
            <div className={styles.search} role="search">
              <span className={styles.searchIcon} aria-hidden="true">
                <Icon icon={Search} size={16} />
              </span>
              <TextField
                type="search"
                label={t('memory.search.label')}
                hideLabel
                placeholder={t('memory.search.placeholder')}
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
          )}
        </div>
        <p className="visually-hidden" role="status">
          {announcement}
        </p>
        {body}
      </section>
      {!isEmptyAccount && <DeleteAllMemories onDeleted={focusList} />}
    </>
  );
}
