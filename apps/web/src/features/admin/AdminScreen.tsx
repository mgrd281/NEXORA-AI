'use client';

import type { AdminOverview, AdminUser, AuditEvent, TaskStatus } from '@jarvis/contracts';
import { useIsFetching, useQueryClient } from '@tanstack/react-query';
import type { LucideIcon } from 'lucide-react';
import {
  Bot,
  ListChecks,
  RefreshCw,
  ScrollText,
  Server,
  ShieldCheck,
  ShieldX,
  TriangleAlert,
  UserRound,
  UsersRound,
  Wrench,
} from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Page } from '@/components/shell/Page';
import { TaskStatusPill } from '@/components/tasks/TaskStatusPill';
import { Badge, type Tone } from '@/components/ui/Badge';
import { Banner, ErrorBanner } from '@/components/ui/Banner';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { Money } from '@/components/ui/Money';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { Skeleton, SkeletonRow } from '@/components/ui/Skeleton';
import { Switch } from '@/components/ui/Switch';
import { useI18n } from '@/i18n/I18nProvider';
import type { MessageKey } from '@/i18n/catalog';
import { isApiError } from '@/lib/api/client';
import { useMe } from '@/lib/api/hooks';
import { qk } from '@/lib/api/query-keys';
import { cx } from '@/lib/cx';
import { useAdminAudit, useAdminOverview, useAdminUsers } from './api';
import {
  auditEventKey,
  auditTargetKey,
  groupAuditEvents,
  isAdminView,
  isLowRate,
  LOW_SUCCESS_RATE,
  orderedStatusCounts,
  shortId,
  successRate,
  toolLabelKey,
  type AuditRow,
} from './format';
import styles from './admin.module.css';

export function AdminScreen() {
  const { t } = useI18n();
  const me = useMe();
  const isAdmin = me.data?.roles.includes('platform_admin') ?? false;
  if (me.isPending) {
    return (
      <Page title={t('admin.title')} width="wide">
        <OverviewSkeleton />
      </Page>
    );
  }
  if (me.isError) {
    return (
      <Page title={t('admin.title')} width="wide">
        <ErrorBanner error={me.error} onRetry={() => void me.refetch()} retrying={me.isFetching} />
      </Page>
    );
  }
  if (!isAdmin) return <Forbidden />;
  return <AdminDashboard />;
}

function Forbidden() {
  const { t } = useI18n();
  return (
    <Page title={t('admin.title')}>
      <Card padding="none">
        <EmptyState
          icon={ShieldX}
          message={t('admin.forbidden')}
          action={
            <ButtonLink href="/" size="sm">
              {t('admin.forbiddenAction')}
            </ButtonLink>
          }
        />
      </Card>
    </Page>
  );
}

function AdminDashboard() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const overview = useAdminOverview(true);
  const fetching = useIsFetching({ queryKey: qk.admin.all }) > 0;

  if (overview.isError && isApiError(overview.error, 'FORBIDDEN')) return <Forbidden />;

  return (
    <Page
      title={t('admin.title')}
      description={t('admin.description')}
      width="wide"
      actions={
        <div className={styles.headerActions}>
          {overview.data && (
            <span className={styles.updated}>
              <RelativeTime
                value={overview.data.generatedAt}
                format={(time) => t('admin.updated', { time })}
              />
            </span>
          )}
          <Button
            size="sm"
            icon={RefreshCw}
            loading={fetching}
            onClick={() => void queryClient.invalidateQueries({ queryKey: qk.admin.all })}
          >
            {t('admin.refresh')}
          </Button>
        </div>
      }
    >
      <Banner tone="info" title={t('admin.notice')}>
        {t('admin.auditedNote')}
      </Banner>
      {overview.data ? (
        <OverviewSections overview={overview.data} />
      ) : overview.isError ? (
        <ErrorBanner
          error={overview.error}
          onRetry={() => void overview.refetch()}
          retrying={overview.isFetching}
        />
      ) : (
        <OverviewSkeleton />
      )}
      <UsersSection />
      <AuditSection />
    </Page>
  );
}

/* ------------------------------------------------------------------ overview */

const PLANNER_REASONS: Record<string, MessageKey> = {
  NO_API_KEY: 'admin.health.reasons.NO_API_KEY',
  USER_DISABLED_EXTERNAL_MODELS: 'admin.health.reasons.USER_DISABLED_EXTERNAL_MODELS',
  BUDGET_EXHAUSTED: 'admin.health.reasons.BUDGET_EXHAUSTED',
};
const PROVIDER_NAMES: Record<string, string> = { anthropic: 'Anthropic' };

function AdminSection({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section className={styles.section} aria-labelledby={id}>
      <div className={styles.sectionHeader}>
        <h2 id={id} className={styles.sectionTitle}>
          {title}
        </h2>
        {description && <p className={styles.sectionDescription}>{description}</p>}
        {actions && <div className={styles.sectionActions}>{actions}</div>}
      </div>
      {children}
    </section>
  );
}

function Tile({
  label,
  value,
  caption,
  tone,
}: {
  label: string;
  value: ReactNode;
  caption?: ReactNode;
  tone?: 'ok' | 'bad' | 'neutral';
}) {
  return (
    <div className={styles.tile}>
      <dt className={styles.tileLabel}>{label}</dt>
      <dd className={styles.tileValue}>
        {tone && (
          <span
            className={cx(
              styles.dot,
              tone === 'ok' && styles.dotOk,
              tone === 'bad' && styles.dotBad,
            )}
            aria-hidden="true"
          />
        )}
        <span className={styles.tileValueText}>{value}</span>
      </dd>
      {caption && <dd className={styles.tileCaption}>{caption}</dd>}
    </div>
  );
}

function OverviewSections({ overview }: { overview: AdminOverview }) {
  const { t, f } = useI18n();
  const { health } = overview;
  const reason = health.planner.reason
    ? t(PLANNER_REASONS[health.planner.reason] ?? 'admin.health.reasons.unknown')
    : null;
  const provider = health.planner.provider
    ? (PROVIDER_NAMES[health.planner.provider] ?? health.planner.provider)
    : null;

  return (
    <>
      <AdminSection title={t('admin.health.title')}>
        <dl className={styles.tiles}>
          <Tile
            label={t('admin.health.database')}
            tone={health.database ? 'ok' : 'bad'}
            value={health.database ? t('admin.health.databaseOk') : t('admin.health.databaseDown')}
          />
          <Tile
            label={t('admin.health.worker')}
            tone={health.worker.healthy ? 'ok' : 'bad'}
            value={
              health.worker.healthy ? t('admin.health.workerOk') : t('admin.health.workerDown')
            }
            caption={
              health.worker.lastHeartbeatAt ? (
                <RelativeTime
                  value={health.worker.lastHeartbeatAt}
                  format={(time) => t('admin.health.heartbeat', { time })}
                />
              ) : (
                t('admin.health.noHeartbeat')
              )
            }
          />
          <Tile
            label={t('admin.health.planner')}
            tone={health.planner.mode === 'model' ? 'ok' : 'neutral'}
            value={
              health.planner.mode === 'model'
                ? t('admin.health.plannerModel')
                : t('admin.health.plannerOffline')
            }
            caption={
              health.planner.mode === 'model'
                ? provider && t('admin.health.plannerProvider', { provider })
                : reason
            }
          />
          <Tile
            label={t('admin.health.queue')}
            value={<span className="tabular">{f.number(health.queueDepth)}</span>}
            caption={t('admin.health.queueCaption', { count: health.queueDepth })}
          />
        </dl>
      </AdminSection>

      <AdminSection title={t('admin.usage.title')}>
        <dl className={cx(styles.tiles, styles.tiles3)}>
          <Tile
            label={t('admin.usage.users')}
            value={<span className="tabular">{f.number(overview.users.total)}</span>}
            caption={t('admin.usage.usersCaption', { count: f.number(overview.users.active7d) })}
          />
          <Tile
            label={t('admin.usage.tenants')}
            value={<span className="tabular">{f.number(overview.tenants.total)}</span>}
            caption={t('admin.usage.tenantsCaption')}
          />
          <Tile
            label={t('admin.usage.cost')}
            value={<Money microUsd={overview.cost30dMicroUsd} />}
            caption={t('admin.usage.costCaption')}
          />
        </dl>
      </AdminSection>

      <TasksByStatus byStatus={overview.tasksByStatus} />
      <ToolReliability rows={overview.toolReliability} />
    </>
  );
}

function TasksByStatus({ byStatus }: { byStatus: Record<string, number> }) {
  const { t, f } = useI18n();
  const rows = orderedStatusCounts(byStatus);
  const total = rows.reduce((sum, r) => sum + r.count, 0);
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <AdminSection
      title={t('admin.tasks.title')}
      description={total > 0 ? t('admin.tasks.total', { count: total }) : undefined}
    >
      <Card padding="none">
        {rows.length === 0 ? (
          <EmptyState icon={ListChecks} message={t('admin.tasks.empty')} />
        ) : (
          <ul className={styles.statusList}>
            {rows.map((r) => (
              <li key={r.status} className={styles.statusRow}>
                <span className={styles.statusLabel}>
                  {r.known ? (
                    <TaskStatusPill status={r.status as TaskStatus} />
                  ) : (
                    <Badge>{r.status}</Badge>
                  )}
                </span>
                <span className={styles.bar} aria-hidden="true">
                  <span
                    className={styles.barFill}
                    style={{ inlineSize: `${(r.count / max) * 100}%` }}
                  />
                </span>
                <span className={cx(styles.statusCount, 'tabular')}>{f.number(r.count)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </AdminSection>
  );
}

function ToolReliability({ rows }: { rows: AdminOverview['toolReliability'] }) {
  const { t, f } = useI18n();
  const ms = (v: number | null) =>
    v === null ? t('admin.tools.none') : f.duration(Math.round(v), 'compact');
  return (
    <AdminSection title={t('admin.tools.title')}>
      {rows.length === 0 ? (
        <Card padding="none">
          <EmptyState icon={Wrench} message={t('admin.tools.empty')} />
        </Card>
      ) : (
        <TableFrame caption={t('admin.tools.caption')}>
          <thead>
            <tr>
              <th scope="col">{t('admin.tools.tool')}</th>
              <th scope="col" className={styles.num}>
                {t('admin.tools.executions')}
              </th>
              <th scope="col" className={styles.num}>
                {t('admin.tools.successRate')}
              </th>
              <th scope="col" className={styles.num}>
                {t('admin.tools.failed')}
              </th>
              <th scope="col" className={styles.num}>
                {t('admin.tools.p50')}
              </th>
              <th scope="col" className={styles.num}>
                {t('admin.tools.p95')}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const key = toolLabelKey(r.toolId);
              const rate = successRate(r.succeeded, r.executions);
              return (
                <tr key={r.toolId}>
                  <th scope="row">
                    <span className={styles.cellStack}>
                      <span>{key ? t(key) : r.toolId}</span>
                      {key && <span className={cx(styles.mono, 'ltr')}>{r.toolId}</span>}
                    </span>
                  </th>
                  <td className={styles.num}>{f.number(r.executions)}</td>
                  <td className={styles.num}>
                    {rate === null ? (
                      t('admin.tools.none')
                    ) : isLowRate(rate) ? (
                      // Below the threshold: said in words with an icon, not by colour alone.
                      <Badge tone="warning" icon={TriangleAlert}>
                        {t('admin.tools.rateLow', {
                          rate: f.percent(rate),
                          threshold: f.percent(LOW_SUCCESS_RATE),
                        })}
                      </Badge>
                    ) : (
                      f.percent(rate)
                    )}
                  </td>
                  <td className={styles.num}>{f.number(r.failed)}</td>
                  <td className={styles.num}>{ms(r.p50Ms)}</td>
                  <td className={styles.num}>{ms(r.p95Ms)}</td>
                </tr>
              );
            })}
          </tbody>
        </TableFrame>
      )}
    </AdminSection>
  );
}

/* ------------------------------------------------------------------ tables */

/**
 * A table that scrolls sideways inside its card on narrow screens, with the first column
 * pinned. The scroll container is focusable so keyboard users can scroll it too.
 */
function TableFrame({
  caption,
  className,
  children,
}: {
  caption: string;
  className?: string;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const hintId = useId();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const overflowing = useOverflowing(scrollerRef);
  return (
    <div className={cx(styles.tableCard, className)}>
      <div
        ref={scrollerRef}
        className={styles.scroller}
        role="region"
        aria-label={caption}
        aria-describedby={overflowing ? hintId : undefined}
        // A scrollable region must be focusable so keyboard users can scroll it (WCAG 2.1.1).
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
      >
        <table className={styles.table}>
          <caption className="visually-hidden">{caption}</caption>
          {children}
        </table>
      </div>
      {overflowing && (
        <p id={hintId} className={styles.scrollHint}>
          {t('admin.scrollHint')}
        </p>
      )}
    </div>
  );
}

/** True while the element's content is wider than the element (it scrolls sideways). */
function useOverflowing(ref: RefObject<HTMLElement | null>): boolean {
  const [overflowing, setOverflowing] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const check = () => setOverflowing(el.scrollWidth > el.clientWidth + 1);
    const observer = new ResizeObserver(check);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    check();
    return () => observer.disconnect();
  }, [ref]);
  return overflowing;
}

function LoadMore({
  hasMore,
  loading,
  onLoad,
}: {
  hasMore: boolean;
  loading: boolean;
  onLoad: () => void;
}) {
  const { t } = useI18n();
  if (!hasMore) return null;
  return (
    <div className={styles.more}>
      <Button onClick={onLoad} loading={loading}>
        {t('common.actions.loadMore')}
      </Button>
    </div>
  );
}

const USER_STATUS_TONE: Record<AdminUser['status'], Tone> = {
  active: 'success',
  disabled: 'warning',
  deleted: 'neutral',
};

function UsersSection() {
  const { t, f } = useI18n();
  const users = useAdminUsers(true);
  const items = users.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <AdminSection title={t('admin.users.title')}>
      {users.isPending ? (
        <TableSkeleton />
      ) : users.isError && items.length === 0 ? (
        <ErrorBanner
          error={users.error}
          onRetry={() => void users.refetch()}
          retrying={users.isFetching}
        />
      ) : items.length === 0 ? (
        <Card padding="none">
          <EmptyState icon={UsersRound} message={t('admin.users.empty')} />
        </Card>
      ) : (
        <>
          <TableFrame caption={t('admin.users.caption')}>
            <thead>
              <tr>
                <th scope="col">{t('admin.users.email')}</th>
                <th scope="col">{t('admin.users.tenant')}</th>
                <th scope="col">{t('admin.users.roles')}</th>
                <th scope="col">{t('admin.users.status')}</th>
                <th scope="col">{t('admin.users.created')}</th>
                <th scope="col">{t('admin.users.lastActive')}</th>
                <th scope="col" className={styles.num}>
                  {t('admin.users.tasks')}
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((u) => (
                <tr key={u.id}>
                  <th scope="row" className={styles.wrapEmail}>
                    <EmailAddress email={u.email} />
                  </th>
                  <td className={styles.wrap}>
                    <bdi>{u.tenantName}</bdi>
                  </td>
                  <td>
                    <span className={styles.badges}>
                      {u.roles.map((r) => (
                        <Badge key={r}>{t(`admin.roles.${r}`)}</Badge>
                      ))}
                    </span>
                  </td>
                  <td>
                    <Badge tone={USER_STATUS_TONE[u.status]}>
                      {t(`admin.users.statuses.${u.status}`)}
                    </Badge>
                  </td>
                  <td>{f.date(u.createdAt)}</td>
                  <td>
                    {u.lastActiveAt ? (
                      <RelativeTime value={u.lastActiveAt} />
                    ) : (
                      <span className={styles.muted}>{t('admin.users.never')}</span>
                    )}
                  </td>
                  <td className={styles.num}>{f.number(u.taskCount)}</td>
                </tr>
              ))}
            </tbody>
          </TableFrame>
          {users.isError && <ErrorBanner error={users.error} />}
          <LoadMore
            hasMore={users.hasNextPage}
            loading={users.isFetchingNextPage}
            onLoad={() => void users.fetchNextPage()}
          />
        </>
      )}
    </AdminSection>
  );
}

/** An email address that may break only after the "@" (never inside a word). */
function EmailAddress({ email }: { email: string }) {
  const at = email.lastIndexOf('@');
  if (at <= 0) return <span className="ltr">{email}</span>;
  return (
    <span className="ltr">
      {email.slice(0, at + 1)}
      <wbr />
      {email.slice(at + 1)}
    </span>
  );
}

const ACTOR_ICON: Record<AuditEvent['actorType'], LucideIcon> = {
  user: UserRound,
  admin: ShieldCheck,
  agent: Bot,
  system: Server,
};

/** Account emails by user id, from the Users list (already loaded on this page). */
function useUserEmails(): Map<string, string> {
  const users = useAdminUsers(true);
  return useMemo(
    () => new Map((users.data?.pages.flatMap((p) => p.items) ?? []).map((u) => [u.id, u.email])),
    [users.data],
  );
}

function AuditSection() {
  const { t } = useI18n();
  const audit = useAdminAudit(true);
  const emails = useUserEmails();
  const [showAdminViews, setShowAdminViews] = useState(false);
  const items = audit.data?.pages.flatMap((p) => p.items) ?? [];
  const rows = groupAuditEvents(items, !showAdminViews);
  const hasAdminViews = items.some((e) => isAdminView(e.action));
  return (
    <AdminSection
      title={t('admin.audit.title')}
      actions={
        hasAdminViews && (
          <Switch
            checked={showAdminViews}
            onChange={setShowAdminViews}
            label={t('admin.audit.showAdminViews')}
            className={styles.headerSwitch}
          />
        )
      }
    >
      {audit.isPending ? (
        <TableSkeleton />
      ) : audit.isError && items.length === 0 ? (
        <ErrorBanner
          error={audit.error}
          onRetry={() => void audit.refetch()}
          retrying={audit.isFetching}
        />
      ) : items.length === 0 ? (
        <Card padding="none">
          <EmptyState icon={ScrollText} message={t('admin.audit.empty')} />
        </Card>
      ) : (
        <>
          {/* From 640 px: a table. Phones: one stacked entry per event (sentence, then who
              and when), so the event itself never scrolls out of view. */}
          <TableFrame caption={t('admin.audit.caption')} className={styles.auditTable}>
            <thead>
              <tr>
                <th scope="col">{t('admin.audit.event')}</th>
                <th scope="col">{t('admin.audit.actor')}</th>
                <th scope="col">{t('admin.audit.target')}</th>
                <th scope="col" className={styles.end}>
                  {t('admin.audit.time')}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key}>
                  <th scope="row">
                    <AuditEventText row={row} withKey />
                  </th>
                  <td>
                    <AuditActor event={row.event} emails={emails} />
                  </td>
                  <td>
                    <AuditTarget event={row.event} emails={emails} />
                  </td>
                  <td className={cx(styles.end, styles.time)}>
                    <AuditTime at={row.event.at} />
                  </td>
                </tr>
              ))}
            </tbody>
          </TableFrame>
          <Card padding="none" className={styles.auditListCard}>
            <ul className={styles.auditList} aria-label={t('admin.audit.caption')}>
              {rows.map((row) => (
                <li key={row.key} className={styles.auditItem}>
                  <span className={styles.auditSentence}>
                    <AuditEventText row={row} />
                  </span>
                  <span className={styles.auditMeta}>
                    <AuditActor event={row.event} emails={emails} compact />
                    <span aria-hidden="true">·</span>
                    <AuditTime at={row.event.at} />
                  </span>
                </li>
              ))}
            </ul>
          </Card>
          {audit.isError && <ErrorBanner error={audit.error} />}
          <LoadMore
            hasMore={audit.hasNextPage}
            loading={audit.isFetchingNextPage}
            onLoad={() => void audit.fetchNextPage()}
          />
        </>
      )}
    </AdminSection>
  );
}

/** "Signed in" (with the raw action key as a caption), or "Viewed admin pages 12 times". */
function AuditEventText({
  row,
  withKey = false,
}: {
  row: AuditRow<AuditEvent>;
  withKey?: boolean;
}) {
  const { t } = useI18n();
  if (row.kind === 'adminViews') {
    return <span>{t('admin.audit.adminViews', { count: row.count })}</span>;
  }
  const action = row.event.action;
  const key = auditEventKey(action);
  if (!key) return <span className={cx(styles.mono, styles.monoPrimary, 'ltr')}>{action}</span>;
  return withKey ? (
    <span className={styles.cellStack}>
      <span>{t(key)}</span>
      <span className={cx(styles.mono, 'ltr')}>{action}</span>
    </span>
  ) : (
    <span title={action}>{t(key)}</span>
  );
}

/**
 * Who acted: the account's email when it is known, JARVIS for the agent, or System. `compact`
 * (the phone list) names the admin role with the icon instead of a badge, so actor and time
 * stay on one line.
 */
function AuditActor({
  event,
  emails,
  compact = false,
}: {
  event: AuditEvent;
  emails: Map<string, string>;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const email = event.actorId ? emails.get(event.actorId) : undefined;
  const who = email ?? (event.actorId ? shortId(event.actorId) : null);
  const adminIcon = compact && event.actorType === 'admin';
  const icon = (
    <Icon
      icon={ACTOR_ICON[event.actorType]}
      size={16}
      label={adminIcon ? t('admin.audit.actors.admin') : undefined}
    />
  );
  if (event.actorType === 'agent' || event.actorType === 'system') {
    return (
      <span
        className={styles.actor}
        title={
          event.actorType === 'agent' && who ? t('admin.audit.agentFor', { actor: who }) : undefined
        }
      >
        {icon}
        <span>{t(`admin.audit.actors.${event.actorType}`)}</span>
      </span>
    );
  }
  return (
    <span className={styles.actor} title={event.actorId ?? undefined}>
      {icon}
      {who ? (
        <span className={cx('ltr', !email && styles.mono)}>{who}</span>
      ) : (
        <span>{t(`admin.audit.actors.${event.actorType}`)}</span>
      )}
      {event.actorType === 'admin' && !compact && <Badge>{t('admin.audit.actors.admin')}</Badge>}
    </span>
  );
}

function AuditTarget({ event, emails }: { event: AuditEvent; emails: Map<string, string> }) {
  const { t } = useI18n();
  if (!event.targetType) return <span className={styles.muted}>{t('admin.tools.none')}</span>;
  const key = auditTargetKey(event.targetType);
  const id = event.targetId;
  const email = event.targetType === 'user' && id ? emails.get(id) : undefined;
  return (
    <span className={styles.target} title={id ?? undefined}>
      <span>{key ? t(key) : event.targetType}</span>
      {email ? (
        <span className="ltr">{email}</span>
      ) : id ? (
        <span className={cx(styles.mono, 'ltr')}>{shortId(id)}</span>
      ) : null}
    </span>
  );
}

function AuditTime({ at }: { at: string }) {
  const { f } = useI18n();
  return (
    <time dateTime={at} className="tabular">
      {f.dateTime(at)}
    </time>
  );
}

/* ------------------------------------------------------------------ loading */

function OverviewSkeleton() {
  const { t } = useI18n();
  return (
    <div className={styles.section} aria-busy="true">
      <span className="visually-hidden" role="status">
        {t('admin.loading')}
      </span>
      <Skeleton width={120} height={20} />
      <div className={styles.tiles} aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className={styles.tile}>
            <Skeleton width="50%" height={12} />
            <Skeleton width="70%" height={20} />
          </div>
        ))}
      </div>
    </div>
  );
}

function TableSkeleton() {
  return (
    <Card padding="none">
      <div aria-busy="true">
        <SkeletonRow />
        <SkeletonRow />
      </div>
    </Card>
  );
}
